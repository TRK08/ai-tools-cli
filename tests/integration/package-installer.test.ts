import { access, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Installer, type PackagePreview } from '@/installer';
import { installerFileSystem } from '@/installer/filesystem';
import { RegistryClient } from '@/registry';
import { getStatePaths } from '@/state';
import { defaultStateFileIO } from '@/state/store';
import { Telemetry } from '@/telemetry';
import { registrySkill, TestRegistry } from '../helpers/registry.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

const approve = async () => 'approve' as const;
const all = async (items: readonly PackagePreview[]) => items.map((item) => item.slug);
const absent = (path: string) => expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });

describe('package file and lock transaction', () => {
  it.each(['download', 'unsafe ZIP', 'second skill', 'lock'] as const)(
    'rolls back all previously installed copies after %s fails',
    async (failure) => {
      const registry = new TestRegistry();
      registry.release('docs', '1.0.0', ['check', 'compare']);
      await withTestEnvironment(async (f) => {
        const paths = getStatePaths(f.roots, 'project');
        const directories = ['check', 'compare'].flatMap((name) =>
          ['.agents', '.claude'].map((agent) => join(f.roots.cwd, agent, 'skills', `docs-${name}`)),
        );
        const client = new RegistryClient(registry.url, registry.http);
        const fixture = { ...f, http: registry.http };
        const installer = new Installer(fixture, { scope: 'project' });
        await installer.add(
          client,
          await client.getPackage({ slug: 'docs' }),
          [],
          ['codex', 'claude-code'],
          approve,
        );
        const original = await readFile(paths.lockPath);
        const bytes = await Promise.all(directories.map((dir) => readFile(join(dir, 'SKILL.md'))));
        registry.release('docs', '2.0.0', ['check', 'compare']);
        if (failure === 'download') registry.corrupt.add('docs/compare');
        if (failure === 'unsafe ZIP')
          registry.releases.get('docs@2.0.0')![1] = registrySkill('docs', 'compare', '2.0.0', {
            mutateEntries: (entries) => entries.push(entries[0]!),
          });
        const telemetry = new Telemetry({ ...fixture, env: {} });
        const failing = new Installer(fixture, {
          scope: 'project',
          telemetry,
          fileSystem: {
            ...installerFileSystem,
            rename: async (from, to) => {
              if (
                failure === 'second skill' &&
                String(from).endsWith('staging-1') &&
                to === directories[2]
              )
                throw new Error('injected rename');
              return installerFileSystem.rename(from, to);
            },
          },
          stateIO: {
            ...defaultStateFileIO,
            rename: async (from, to) => {
              if (failure === 'lock') throw new Error('injected lock');
              return defaultStateFileIO.rename(from, to);
            },
          },
        });
        const result = await failing.update({ skills: [], agents: [] }, all);
        await telemetry.flush();
        expect(result.updated).toEqual([]);
        expect(result.failures).toEqual([
          {
            slug: 'docs',
            error: expect.stringMatching(
              failure === 'download'
                ? /SHA-256/
                : failure === 'unsafe ZIP'
                  ? /Повторяющийся/
                  : /injected/,
            ),
          },
        ]);
        expect(await readFile(paths.lockPath)).toEqual(original);
        expect(
          await Promise.all(directories.map((dir) => readFile(join(dir, 'SKILL.md')))),
        ).toEqual(bytes);
        expect(
          registry.events.map(({ body }) => [body.event, body.components.map((item) => item.name)]),
        ).toEqual([
          [
            'download',
            failure === 'download' || failure === 'unsafe ZIP' ? ['check'] : ['check', 'compare'],
          ],
        ]);
        expect(
          (await readdir(paths.agentsDirectory)).filter((item) =>
            item.startsWith('.skills-installer-work-'),
          ),
        ).toEqual([]);
        await absent(paths.operationLockPath);
      });
    },
  );

  it('keeps the area locked during review and detects edits after review', async () => {
    const registry = new TestRegistry();
    registry.release('docs', '1.0.0', ['check', 'compare']);
    await withTestEnvironment(async (f) => {
      const client = new RegistryClient(registry.url, registry.http);
      const installer = new Installer({ ...f, http: registry.http }, { scope: 'project' });
      await installer.add(
        client,
        await client.getPackage({ slug: 'docs' }),
        [],
        ['codex'],
        approve,
      );
      registry.release('docs', '2.0.0', ['check', 'compare']);
      const manual = join(f.roots.cwd, '.agents/skills/docs-compare/SKILL.md');
      const result = await installer.update({ skills: [], agents: [] }, async (previews) => {
        await expect(installer.remove('docs', [], [], approve)).rejects.toMatchObject({
          code: 'SCOPE_BUSY',
        });
        await writeFile(manual, 'changed during review');
        return all(previews);
      });
      expect(result.failures[0]?.error).toContain('после проверки');
      expect((await installer.list())[0]?.version).toBe('1.0.0');
      expect(await readFile(manual, 'utf8')).toBe('changed during review');
      expect(
        await readFile(join(f.roots.cwd, '.agents/skills/docs-check/SKILL.md'), 'utf8'),
      ).toContain('1.0.0');
    });
  });

  it('rolls back removal of a whole package when lock commit fails', async () => {
    const registry = new TestRegistry();
    registry.release('docs', '1.0.0', ['check', 'compare']);
    await withTestEnvironment(async (f) => {
      const context = { ...f, http: registry.http };
      const client = new RegistryClient(registry.url, registry.http);
      const installer = new Installer(context, { scope: 'global' });
      await installer.add(
        client,
        await client.getPackage({ slug: 'docs' }),
        [],
        ['codex', 'claude-code'],
        approve,
      );
      const failing = new Installer(context, {
        scope: 'global',
        stateIO: {
          ...defaultStateFileIO,
          rename: async () => {
            throw new Error('injected lock');
          },
        },
      });
      await expect(failing.remove('docs', [], [], approve)).rejects.toThrow('injected lock');
      expect((await installer.list())[0]?.skills).toHaveLength(2);
      for (const name of ['check', 'compare']) {
        const link = join(f.roots.home, '.claude/skills', `docs-${name}`);
        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        expect(await readFile(join(link, 'SKILL.md'), 'utf8')).toContain('1.0.0');
      }
    });
  });

  it('rejects a foreign copy on any skill without applying others', async () => {
    const registry = new TestRegistry();
    registry.release('docs', '1.0.0', ['check', 'compare']);
    await withTestEnvironment(async (f) => {
      const installer = new Installer({ ...f, http: registry.http }, { scope: 'project' });
      const client = new RegistryClient(registry.url, registry.http);
      const foreign = join(f.roots.cwd, '.claude/skills/docs-compare/SKILL.md');
      await mkdir(dirname(foreign), { recursive: true });
      await writeFile(foreign, 'foreign');
      await expect(
        installer.add(
          client,
          await client.getPackage({ slug: 'docs' }),
          [],
          ['codex', 'claude-code'],
          approve,
        ),
      ).rejects.toThrow(/чужим объектом/);
      expect(await installer.list()).toEqual([]);
      expect(await readFile(foreign, 'utf8')).toBe('foreign');
      await absent(join(f.roots.cwd, '.agents/skills/docs-check'));
    });
  });

  it('keeps the registered global Claude path when the environment changes', async () => {
    const registry = new TestRegistry();
    registry.release('docs', '1.0.0', ['check']);
    await withTestEnvironment(async (f) => {
      const client = new RegistryClient(registry.url, registry.http);
      const old = join(f.temporaryRoot, 'old-claude');
      const next = join(f.temporaryRoot, 'new-claude');
      const installerFor = (directory: string) =>
        new Installer(
          {
            ...f,
            http: registry.http,
            env: { ...f.env, CLAUDE_CONFIG_DIR: directory },
          },
          { scope: 'global' },
        );
      await installerFor(old).add(
        client,
        await client.getPackage({ slug: 'docs' }),
        [],
        ['claude-code'],
        approve,
      );
      registry.release('docs', '2.0.0', ['check']);
      const after = installerFor(next);
      const updated = await after.update({ skills: [], agents: ['claude-code'] }, all);
      expect(updated).toEqual({ updated: ['docs'], failures: [], cancelled: false });
      expect(await readFile(join(old, 'skills/docs-check/SKILL.md'), 'utf8')).toContain('2.0.0');
      await absent(next);
      await after.remove('docs', [], [], approve);
      await absent(join(old, 'skills/docs-check'));
    });
  });
});
