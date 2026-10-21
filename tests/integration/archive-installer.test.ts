import { samePath } from '../../src/state/native-path.ts';
import { lstat, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { AGENTS, agentSkillsDirectory } from '../../src/installer/agents.ts';

import { Installer } from '../../src/installer/installer.ts';
import { hashDirectory } from '../../src/state/hash.ts';
import { getStatePaths, WORKSPACE_PREFIX } from '../../src/state/paths.ts';
import { StateStore } from '../../src/state/store.ts';
import { archiveBytes, rawTar, skillText } from '../helpers/archive.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

const ids = AGENTS.map((agent) => agent.id);

describe.each(['project', 'global'] as const)('%s archive lifecycle', (scope) => {
  it.each(['tgz'])(
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
        const installer = new Installer(f, { scope });
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
          if (process.platform !== 'win32')
            expect((await lstat(join(destination, 'run.sh'))).mode & 0o777).toBe(0o755);
          if (destination === copy || scope === 'project')
            expect((await lstat(destination)).isSymbolicLink()).toBe(false);
          else
            expect(samePath(resolve(dirname(destination), await readlink(destination)), copy)).toBe(
              true,
            );
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
      const installer = new Installer(f, { scope, report });
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
});
