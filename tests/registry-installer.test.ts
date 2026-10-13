import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AGENTS, agentSkillsDirectory } from '../src/installer/agents.ts';
import { installerFileSystem } from '../src/installer/filesystem.ts';
import { LocalInstaller } from '../src/installer/local.ts';
import { hashDirectory } from '../src/state/hash.ts';
import { getStatePaths, WORKSPACE_PREFIX } from '../src/state/paths.ts';
import { StateStore } from '../src/state/store.ts';
import { archiveBytes, skillText } from './helpers/archive.ts';
import { artifact, json, registryBytes, withRegistryServer } from './helpers/registry.ts';
import { withTestEnvironment } from './helpers/test-environment.ts';

const ids = AGENTS.map((agent) => agent.id);

describe.each(['project', 'global'] as const)('%s registry lifecycle', (scope) => {
  it.each(['demo', 'demo@1.2.3'])(
    'installs %s for five agents and persists permanent identity only',
    async (source) => {
      await withRegistryServer(async ({ url, requests }) =>
        withTestEnvironment(
          async (f) => {
            const paths = getStatePaths(f.roots, scope);
            const downloads = vi.fn();
            const installer = new LocalInstaller(f, { scope, onDownload: downloads });
            const result = await installer.add(source, false, ids);
            expect(result.status).toBe('success');
            expect(result.download).toEqual(downloads.mock.calls[0]![0]);
            const record = (await new StateStore(paths).read())!.skills.demo!;
            const copy = join(paths.skillsDirectory, 'demo');
            expect(record).toMatchObject({
              source: { kind: 'registry', registryUrl: url, slug: 'demo' },
              version: '1.2.3',
              policy: source.includes('@') ? 'exact' : 'latest',
              archiveHash: artifact(url).sha256,
              contentHash: await hashDirectory(copy),
              agents: [...ids].sort(),
            });
            expect(await readFile(paths.lockPath, 'utf8')).not.toMatch(
              /signature|secret|expires|download|artifact\.tar\.gz/,
            );
            for (const agent of ids) {
              const path = join(agentSkillsDirectory(f, scope, agent), 'demo');
              expect(await readFile(join(path, 'resource'))).toEqual(Buffer.from([0, 255, 128]));
              expect((await lstat(join(path, 'run.sh'))).mode & 0o777).toBe(0o711);
              if (path !== copy) expect(resolve(dirname(path), await readlink(path))).toBe(copy);
            }
            expect(requests[0]).toBe(
              `/api/v1/skills/demo/artifact${source.includes('@') ? '?version=1.2.3' : ''}`,
            );
            const before = await readFile(paths.lockPath);
            expect((await installer.add(source, false, ['pi'])).status).toBe('unchanged');
            expect(await readFile(paths.lockPath)).toEqual(before);
            await installer.remove('demo', ['pi']);
            expect((await installer.list())[0]!.agents).not.toContain('pi');
            await installer.remove('demo');
            await expect(lstat(copy)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(
              (await readdir(paths.agentsDirectory)).filter((n) => n.startsWith(WORKSPACE_PREFIX)),
            ).toEqual([]);
          },
          { http: fetch, env: { SKILLS_API_URL: url, SKILLS_API_TOKEN: 'unused-secret' } },
        ),
      );
    },
  );

  it.each([
    '404',
    '503',
    'size',
    'hash',
    'version',
    'name',
    'corrupt',
    'unsafe',
    'refresh-identity',
  ])('preserves the existing installation after %s fails', async (failure) => {
    let failing = false;
    let failingMetadata = 0;
    await withRegistryServer(
      async ({ url }) =>
        withTestEnvironment(
          async (f) => {
            const paths = getStatePaths(f.roots, scope);
            const copy = join(paths.skillsDirectory, 'demo');
            const downloads = vi.fn();
            const installer = new LocalInstaller(f, {
              scope,
              registry: url,
              onDownload: downloads,
            });
            await installer.add('demo@1.2.3', false, ids);
            // A forced replacement must download even when version/digest are unchanged.
            await writeFile(join(copy, 'manual-edit'), 'keep on failure');
            const before = {
              lock: await readFile(paths.lockPath),
              hash: await hashDirectory(copy),
              inode: (await lstat(copy)).ino,
            };
            const links = await Promise.all(
              ids
                .filter((id) => join(agentSkillsDirectory(f, scope, id), 'demo') !== copy)
                .map(async (id) => {
                  const path = join(agentSkillsDirectory(f, scope, id), 'demo');
                  return { path, inode: (await lstat(path)).ino, target: await readlink(path) };
                }),
            );
            failing = true;
            await expect(installer.add('demo@1.2.3', true, ids)).rejects.toBeInstanceOf(Error);
            expect({
              lock: await readFile(paths.lockPath),
              hash: await hashDirectory(copy),
              inode: (await lstat(copy)).ino,
            }).toEqual(before);
            for (const link of links) {
              expect((await lstat(link.path)).ino).toBe(link.inode);
              expect(await readlink(link.path)).toBe(link.target);
            }
            expect(
              (await readdir(paths.agentsDirectory)).filter((n) => n.startsWith(WORKSPACE_PREFIX)),
            ).toEqual([]);
            await expect(lstat(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(downloads).toHaveBeenCalledTimes(
              ['name', 'corrupt', 'unsafe'].includes(failure) ? 2 : 1,
            );
          },
          { http: fetch },
        ),
      (req, res, url) => {
        const bytes = !failing
          ? registryBytes
          : failure === 'name'
            ? archiveBytes([
                { path: 'SKILL.md', contents: skillText.replace('name: demo', 'name: other') },
              ])
            : failure === 'unsafe'
              ? archiveBytes([
                  { path: '../sentinel', contents: 'bad' },
                  { path: 'SKILL.md', contents: skillText },
                ])
              : failure === 'corrupt'
                ? Buffer.from('not a tar')
                : registryBytes;
        if (req.url!.startsWith('/api/')) {
          if (failing && ['404', '503'].includes(failure))
            return json(
              res,
              {
                code: failure === '404' ? 'not_found' : 'service_unavailable',
                message:
                  failure === '404'
                    ? 'Skill or version not found'
                    : 'Service temporarily unavailable',
                debugMessage: null,
              },
              Number(failure),
            );
          const refreshing = failing && failure === 'refresh-identity' && ++failingMetadata > 1;
          json(
            res,
            artifact(`${url}/download`, {
              size: bytes.length + (failing && failure === 'size' ? 1 : 0),
              sha256:
                failing && (failure === 'hash' || refreshing)
                  ? 'a'.repeat(64)
                  : createHash('sha256').update(bytes).digest('hex'),
              version: failing && failure === 'version' ? '2.0.0' : '1.2.3',
            }),
          );
        } else if (failing && failure === 'refresh-identity') res.writeHead(403).end();
        else res.end(bytes);
      },
    );
  });

  it('preserves the old installation on transport failure and refuses modified contents before HTTP', async () => {
    await withRegistryServer(async ({ url }) =>
      withTestEnvironment(
        async (f) => {
          const paths = getStatePaths(f.roots, scope);
          const installer = new LocalInstaller(f, { scope, registry: url });
          await installer.add('demo', false, ids);
          const oldLock = await readFile(paths.lockPath);
          const oldHash = await hashDirectory(join(paths.skillsDirectory, 'demo'));
          const transport = vi.fn().mockRejectedValue(new Error('network down'));
          const failed = new LocalInstaller({ ...f, http: transport }, { scope, registry: url });
          await expect(failed.add('demo', true, ids)).rejects.toThrow(/Запрос к реестру/);
          expect(await readFile(paths.lockPath)).toEqual(oldLock);
          expect(await hashDirectory(join(paths.skillsDirectory, 'demo'))).toBe(oldHash);
          await writeFile(join(paths.skillsDirectory, 'demo', 'SKILL.md'), 'edited');
          transport.mockClear();
          await expect(failed.add('demo', false, ids)).rejects.toThrow(/изменён локально/);
          expect(transport).not.toHaveBeenCalled();
          await installer.add('demo', true, ids);
          expect(await hashDirectory(join(paths.skillsDirectory, 'demo'))).toBe(oldHash);
        },
        { http: fetch },
      ),
    );
  });

  it('reports partial connections and rolls back when all new links fail', async () => {
    await withRegistryServer(async ({ url }) =>
      withTestEnvironment(
        async (f) => {
          const paths = getStatePaths(f.roots, scope);
          const foreign = join(agentSkillsDirectory(f, scope, 'pi'), 'demo');
          await mkdir(foreign, { recursive: true });
          await writeFile(join(foreign, 'sentinel'), 'keep');
          const installer = new LocalInstaller(f, { scope, registry: url });
          expect((await installer.add('demo', false, ['pi', 'codex'])).status).toBe('partial');
          const before = {
            copy: await hashDirectory(join(paths.skillsDirectory, 'demo')),
            lock: await readFile(paths.lockPath),
          };
          const failed = new LocalInstaller(f, {
            scope,
            registry: url,
            fileSystem: {
              ...installerFileSystem,
              symlink: vi.fn().mockRejectedValue(new Error('link failed')),
            },
          });
          expect((await failed.add('demo', false, ['claude-code'])).status).toBe('failed');
          expect({
            copy: await hashDirectory(join(paths.skillsDirectory, 'demo')),
            lock: await readFile(paths.lockPath),
          }).toEqual(before);
          await installer.remove('demo');
          expect(await readFile(join(foreign, 'sentinel'), 'utf8')).toBe('keep');
        },
        { http: fetch },
      ),
    );
  });

  it('rejects another registry and local source conflicts even with force before network', async () => {
    await withRegistryServer(async ({ url, requests }) =>
      withTestEnvironment(
        async (f) => {
          const installer = new LocalInstaller(f, { scope, registry: url });
          await installer.add('demo');
          const before = requests.length;
          const different = new LocalInstaller(f, { scope, registry: `${url}/other` });
          await expect(different.add('demo', true)).rejects.toMatchObject({
            code: 'SOURCE_CONFLICT',
          });
          expect(requests).toHaveLength(before);
          const local = join(f.roots.cwd, 'folder');
          await mkdir(local);
          await writeFile(join(local, 'SKILL.md'), skillText);
          await expect(installer.add(local, true)).rejects.toMatchObject({
            code: 'SOURCE_CONFLICT',
          });
          await installer.remove('demo');
          await installer.add(local);
          await expect(installer.add('demo', true)).rejects.toMatchObject({
            code: 'SOURCE_CONFLICT',
          });
          expect(requests).toHaveLength(before);
        },
        { http: fetch },
      ),
    );
  });
});

it('never sends a bare existing directory or a broken local symlink to the registry', async () => {
  await withTestEnvironment(async (f) => {
    const folder = join(f.roots.cwd, 'demo');
    await mkdir(folder);
    await writeFile(join(folder, 'SKILL.md'), skillText);
    const http = vi.fn().mockRejectedValue(new Error('unexpected HTTP'));
    const installer = new LocalInstaller({ ...f, http }, { registry: 'not a URL' });
    await installer.add('demo');
    await symlink('missing-folder', join(f.roots.cwd, 'broken'));
    await expect(installer.add('broken')).rejects.toBeInstanceOf(Error);
    expect(http).not.toHaveBeenCalled();
  });
});
