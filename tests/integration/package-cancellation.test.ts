import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Installer } from '@/installer';
import { installerFileSystem } from '@/installer/filesystem';
import { RegistryClient } from '@/registry';
import { getStatePaths } from '@/state';
import { defaultStateFileIO } from '@/state/store';
import { TestRegistry } from '../helpers/registry.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

const approve = async () => 'approve' as const;
it.each(['copy', 'apply', 'lock temporary', 'after commit'] as const)(
  'honors cancellation at %s, finishes rollback/cleanup and preserves committed packages',
  async (stage) => {
    await withTestEnvironment(async (f) => {
      const registry = new TestRegistry();
      for (const slug of ['docs', 'reports']) registry.release(slug, '1.0.0', ['check']);
      const context = { ...f, http: registry.http };
      const client = new RegistryClient(registry.url, registry.http);
      const installer = new Installer(context, { scope: 'project' });
      for (const slug of ['docs', 'reports'])
        await installer.add(
          client,
          await client.getPackage({ slug }),
          [],
          ['codex', 'claude-code'],
          approve,
        );
      const paths = getStatePaths(f.roots, 'project');
      const original = await readFile(paths.lockPath);
      const controller = new AbortController();
      for (const slug of ['docs', 'reports']) registry.release(slug, '2.0.0', ['check']);
      const updating = new Installer(
        { ...context, signal: controller.signal },
        {
          scope: 'project',
          fileSystem: {
            ...installerFileSystem,
            cp: async (from, to, options) => {
              await installerFileSystem.cp(from, to, options);
              if (stage === 'copy') controller.abort();
            },
            rename: async (from, to) => {
              await installerFileSystem.rename(from, to);
              if (stage === 'apply' && String(to).endsWith('docs-check')) controller.abort();
            },
          },
          stateIO: {
            ...defaultStateFileIO,
            writeTemporaryFile: async (path, bytes) => {
              await defaultStateFileIO.writeTemporaryFile(path, bytes);
              if (stage === 'lock temporary') controller.abort();
            },
            rename: async (from, to) => {
              await defaultStateFileIO.rename(from, to);
              if (stage === 'after commit') {
                controller.abort();
                controller.abort();
              }
            },
          },
        },
      );
      const result = await updating.update({ skills: [], agents: [] }, async (previews) =>
        previews.map((p) => p.slug),
      );
      expect(result).toEqual({
        updated: stage === 'after commit' ? ['docs'] : [],
        failures: [],
        cancelled: true,
      });
      if (stage !== 'after commit') expect(await readFile(paths.lockPath)).toEqual(original);
      const expected = stage === 'after commit' ? '2.0.0' : '1.0.0';
      for (const agent of ['.agents', '.claude']) {
        expect(
          await readFile(join(f.roots.cwd, agent, 'skills/docs-check/SKILL.md'), 'utf8'),
        ).toContain(expected);
        expect(
          await readFile(join(f.roots.cwd, agent, 'skills/reports-check/SKILL.md'), 'utf8'),
        ).toContain('1.0.0');
      }
      await expect(access(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        (await readdir(paths.agentsDirectory)).filter((name) =>
          name.startsWith('.skills-installer-work-'),
        ),
      ).toEqual([]);
      expect(
        (await readdir(paths.root)).filter((name) => name.startsWith('.skills-installer-lock-')),
      ).toEqual([]);
      expect(
        (await readdir(join(f.roots.home, '.skills-installer/store'))).filter((name) =>
          /\.lock$|\.tmp-/.test(name),
        ),
      ).toEqual([]);
    });
  },
);
