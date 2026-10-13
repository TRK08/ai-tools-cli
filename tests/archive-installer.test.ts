import { lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { AGENTS, agentSkillsDirectory } from '../src/installer/agents.ts';
import { installerFileSystem } from '../src/installer/filesystem.ts';
import { LocalInstaller } from '../src/installer/local.ts';
import { hashDirectory } from '../src/state/hash.ts';
import { getStatePaths, WORKSPACE_PREFIX } from '../src/state/paths.ts';
import { StateStore } from '../src/state/store.ts';
import { archiveBytes, rawTar, skillText } from './helpers/archive.ts';
import { withTestEnvironment } from './helpers/test-environment.ts';

const ids = AGENTS.map((agent) => agent.id);

describe.each(['project', 'global'] as const)('%s archive lifecycle', (scope) => {
  it.each(['tar.gz', 'tgz'])(
    'installs %s for all five agents and retains permanent source identity',
    async (extension) => {
      await withTestEnvironment(async (f) => {
        const source = join(f.roots.cwd, `demo.${extension}`);
        await writeFile(
          source,
          archiveBytes([
            { path: 'outer/SKILL.md', contents: skillText },
            { path: 'outer/resource', contents: Buffer.from([0, 255, 128]) },
            { path: 'outer/run.sh', contents: '#!/bin/sh\nprintf demo\n', mode: 0o755 },
          ]),
        );
        const original = await readFile(source);
        const paths = getStatePaths(f.roots, scope);
        const installer = new LocalInstaller(f, { scope });
        expect((await installer.add(source, false, ids)).status).toBe('success');
        const copy = join(paths.skillsDirectory, 'demo');
        const record = (await new StateStore(paths).read())!.skills.demo!;
        expect(record.source).toEqual({
          kind: 'archive',
          path: scope === 'project' ? `demo.${extension}` : source,
        });
        expect(record.agents).toEqual([...ids].sort());
        expect(record.contentHash).toBe(await hashDirectory(copy));
        expect(record.archiveHash).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(record)).not.toMatch(/skills-installer-(?:archive|work)/);
        for (const agent of ids) {
          const destination = join(agentSkillsDirectory(f, scope, agent), 'demo');
          expect(await readFile(join(destination, 'resource'))).toEqual(Buffer.from([0, 255, 128]));
          expect((await lstat(join(destination, 'run.sh'))).mode & 0o777).toBe(0o755);
          if (destination === copy) expect((await lstat(destination)).isSymbolicLink()).toBe(false);
          else expect(resolve(dirname(destination), await readlink(destination))).toBe(copy);
        }
        const lock = await readFile(paths.lockPath);
        expect((await installer.add(`./demo.${extension}`, false, ['pi'])).status).toBe(
          'unchanged',
        );
        expect(await readFile(paths.lockPath)).toEqual(lock);
        await installer.remove('demo', ['pi']);
        expect((await installer.list(['codex']))[0]!.agents).not.toContain('pi');
        await installer.remove('demo');
        await expect(lstat(copy)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(source)).toEqual(original);
        expect(
          (await readdir(paths.agentsDirectory)).filter((name) =>
            name.startsWith(WORKSPACE_PREFIX),
          ),
        ).toEqual([]);
      });
    },
  );

  it.each(['corrupt', 'unsafe', 'missing-skill', 'invalid-metadata', 'too-many-entries'])(
    'retains installed contents, links and lock after %s preparation fails',
    async (failure) => {
      await withTestEnvironment(async (f) => {
        const source = join(f.roots.cwd, 'demo.tgz');
        await writeFile(source, archiveBytes([{ path: 'SKILL.md', contents: skillText }]));
        const paths = getStatePaths(f.roots, scope);
        const installer = new LocalInstaller(f, { scope });
        await installer.add(source, false, ids);
        const copy = join(paths.skillsDirectory, 'demo');
        const before = {
          hash: await hashDirectory(copy),
          lock: await readFile(paths.lockPath),
          inode: (await lstat(copy)).ino,
        };
        const links = await Promise.all(
          ids
            .filter((agent) => join(agentSkillsDirectory(f, scope, agent), 'demo') !== copy)
            .map(async (agent) => {
              const path = join(agentSkillsDirectory(f, scope, agent), 'demo');
              return { path, target: await readlink(path), inode: (await lstat(path)).ino };
            }),
        );
        const bytes =
          failure === 'corrupt'
            ? Buffer.from('corrupt archive')
            : archiveBytes(
                failure === 'unsafe'
                  ? [{ path: '../outside', contents: 'attack' }]
                  : failure === 'missing-skill'
                    ? [{ path: 'resource', contents: 'no skill' }]
                    : failure === 'invalid-metadata'
                      ? [{ path: 'SKILL.md', contents: 'invalid metadata' }]
                      : [
                          { path: 'SKILL.md', contents: skillText },
                          ...Array.from({ length: 1000 }, (_, i) => ({ path: `empty-${i}` })),
                        ],
              );
        await writeFile(source, bytes);
        await expect(installer.add(source, true, ids)).rejects.toBeInstanceOf(Error);
        expect({
          hash: await hashDirectory(copy),
          lock: await readFile(paths.lockPath),
          inode: (await lstat(copy)).ino,
        }).toEqual(before);
        for (const link of links) {
          expect(await readlink(link.path)).toBe(link.target);
          expect((await lstat(link.path)).ino).toBe(link.inode);
        }
        expect(
          (await readdir(paths.agentsDirectory)).filter((name) =>
            name.startsWith(WORKSPACE_PREFIX),
          ),
        ).toEqual([]);
        await expect(lstat(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      });
    },
  );

  it('protects local edits, merges agents and replaces the shared copy for every connection', async () => {
    await withTestEnvironment(async (f) => {
      const source = join(f.roots.cwd, 'demo.tgz');
      await writeFile(source, archiveBytes([{ path: 'SKILL.md', contents: skillText }]));
      const paths = getStatePaths(f.roots, scope);
      const report = vi.fn();
      const installer = new LocalInstaller(f, { scope, report });
      await installer.add(source, false, ['claude-code']);
      await installer.add(source, false, ['pi']);
      const copy = join(paths.skillsDirectory, 'demo');
      await writeFile(join(copy, 'manual'), 'edits');
      const next = `${skillText}Updated\n`;
      await writeFile(source, archiveBytes([{ path: 'SKILL.md', contents: next }]));
      await expect(installer.add(source, false, ['codex'])).rejects.toThrow(/изменён локально/);
      expect(await readFile(join(copy, 'manual'), 'utf8')).toBe('edits');
      expect((await installer.add(source, true, ['codex'])).status).toBe('success');
      expect(report).toHaveBeenCalledWith(expect.stringContaining('claude-code, codex, pi'));
      expect((await installer.list())[0]!.agents).toEqual(['claude-code', 'codex', 'pi']);
      for (const agent of ['claude-code', 'codex', 'pi'] as const)
        expect(
          await readFile(join(agentSkillsDirectory(f, scope, agent), 'demo', 'SKILL.md'), 'utf8'),
        ).toBe(next);
      await expect(lstat(join(copy, 'manual'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('saves a changed archive digest without replacing identical installed content', async () => {
    await withTestEnvironment(async (f) => {
      const source = join(f.roots.cwd, 'demo.tgz');
      const tar = rawTar([
        { path: 'SKILL.md', contents: skillText },
        { path: 'resource', contents: 'abc'.repeat(1000) },
      ]);
      await writeFile(source, gzipSync(tar, { level: 1 }));
      const paths = getStatePaths(f.roots, scope);
      const report = vi.fn();
      const installer = new LocalInstaller(f, { scope, report });
      await installer.add(source);
      const before = (await installer.list())[0]!;
      const inode = (await lstat(join(paths.skillsDirectory, 'demo'))).ino;
      await writeFile(source, gzipSync(tar, { level: 9 }));
      expect((await installer.add(source)).status).toBe('success');
      const after = (await installer.list())[0]!;
      expect(after.archiveHash).not.toBe(before.archiveHash);
      expect(after.contentHash).toBe(before.contentHash);
      expect((await lstat(join(paths.skillsDirectory, 'demo'))).ino).toBe(inode);
      expect(report).not.toHaveBeenCalled();
      expect((await installer.add(source)).status).toBe('unchanged');
    });
  });

  it('keeps partial success and rolls back a replacement if all new connections fail', async () => {
    await withTestEnvironment(async (f) => {
      const source = join(f.roots.cwd, 'demo.tgz');
      await writeFile(source, archiveBytes([{ path: 'SKILL.md', contents: skillText }]));
      const foreign = join(agentSkillsDirectory(f, scope, 'pi'), 'demo');
      await mkdir(foreign, { recursive: true });
      await writeFile(join(foreign, 'sentinel'), 'keep');
      const installer = new LocalInstaller(f, { scope });
      expect((await installer.add(source, false, ['codex', 'pi'])).status).toBe('partial');
      expect((await installer.list())[0]!.agents).toEqual(['codex']);
      const paths = getStatePaths(f.roots, scope);
      const before = {
        copy: await hashDirectory(join(paths.skillsDirectory, 'demo')),
        lock: await readFile(paths.lockPath),
      };
      await writeFile(source, archiveBytes([{ path: 'SKILL.md', contents: `${skillText}v2\n` }]));
      const failed = new LocalInstaller(f, {
        scope,
        fileSystem: {
          ...installerFileSystem,
          symlink: vi.fn().mockRejectedValue(new Error('link failed')),
        },
      });
      expect((await failed.add(source, false, ['claude-code'])).status).toBe('failed');
      expect({
        copy: await hashDirectory(join(paths.skillsDirectory, 'demo')),
        lock: await readFile(paths.lockPath),
      }).toEqual(before);
      expect(await readFile(join(foreign, 'sentinel'), 'utf8')).toBe('keep');
      await rm(source);
      await installer.remove('demo');
      expect(await readFile(join(foreign, 'sentinel'), 'utf8')).toBe('keep');
    });
  });

  it('requires remove/add before changing from an archive to a folder source even with force', async () => {
    await withTestEnvironment(async (f) => {
      const source = join(f.roots.cwd, 'demo.tgz');
      await writeFile(source, archiveBytes([{ path: 'SKILL.md', contents: skillText }]));
      const directory = join(f.roots.cwd, 'folder.tgz');
      await mkdir(directory);
      await writeFile(join(directory, 'SKILL.md'), skillText);
      const installer = new LocalInstaller(f, { scope });
      await installer.add(source);
      await expect(installer.add(directory, true)).rejects.toMatchObject({
        code: 'SOURCE_CONFLICT',
      });
      await installer.remove('demo');
      expect((await installer.add(directory)).status).toBe('success');
      expect((await installer.list())[0]!.source.kind).toBe('directory');
    });
  });
});
