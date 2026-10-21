import { lstat, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { symlink } from '../helpers/links.ts';
import { samePath } from '../../src/state/native-path.ts';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AGENTS, agentSkillsDirectory } from '../../src/installer/agents.ts';

import { Installer } from '../../src/installer/installer.ts';
import { hashDirectory } from '../../src/state/hash.ts';
import { getStatePaths, WORKSPACE_PREFIX } from '../../src/state/paths.ts';
import { StateStore } from '../../src/state/store.ts';
import { skillText } from '../helpers/archive.ts';
import { artifact, withRegistryServer } from '../helpers/registry.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

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
            const installer = new Installer(f, { scope, onDownload: downloads });
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
              if (process.platform !== 'win32')
                expect((await lstat(join(path, 'run.sh'))).mode & 0o777).toBe(0o711);
              if (path !== copy && scope === 'global')
                expect(samePath(resolve(dirname(path), await readlink(path)), copy)).toBe(true);
              else expect((await lstat(path)).isSymbolicLink()).toBe(false);
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

  it('preserves the old installation on transport failure and refuses modified contents before HTTP', async () => {
    await withRegistryServer(async ({ url }) =>
      withTestEnvironment(
        async (f) => {
          const paths = getStatePaths(f.roots, scope);
          const installer = new Installer(f, { scope, registry: url });
          await installer.add('demo', false, ids);
          const oldLock = await readFile(paths.lockPath);
          const oldHash = await hashDirectory(join(paths.skillsDirectory, 'demo'));
          const transport = vi.fn().mockRejectedValue(new Error('network down'));
          const failed = new Installer({ ...f, http: transport }, { scope, registry: url });
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

  it('rejects another registry and local source conflicts even with force before network', async () => {
    await withRegistryServer(async ({ url, requests }) =>
      withTestEnvironment(
        async (f) => {
          const installer = new Installer(f, { scope, registry: url });
          await installer.add('demo');
          const before = requests.length;
          const different = new Installer(f, { scope, registry: `${url}/other` });
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
    const installer = new Installer({ ...f, http }, { registry: 'not a URL' });
    await installer.add('demo');
    await symlink('missing-folder', join(f.roots.cwd, 'broken'));
    await expect(installer.add('broken')).rejects.toBeInstanceOf(Error);
    expect(http).not.toHaveBeenCalled();
  });
});
