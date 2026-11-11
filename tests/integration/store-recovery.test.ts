import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Installer } from '@/installer';
import { installerFileSystem } from '@/installer/filesystem';
import { RegistryClient } from '@/registry';
import { getStatePaths, StateStore } from '@/state';
import { artifactKey } from '@/store';
import { Telemetry } from '@/telemetry';
import { TestRegistry } from '../helpers/registry.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

const approve = async () => 'approve' as const;
const absent = (path: string) => expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });

it('reuses one verified store entry across projects/global, keeps copies independent and emits only actual events', async () => {
  await withTestEnvironment(async (f) => {
    const registry = new TestRegistry();
    registry.release('docs', '1.0.0', ['check']);
    const context = { ...f, http: registry.http, env: {} };
    const telemetry = new Telemetry(context);
    const client = new RegistryClient(registry.url, registry.http);
    const release = await client.getPackage({ slug: 'docs' });
    const installer = new Installer(context, { scope: 'project', telemetry });
    await installer.add(
      client,
      release,
      [],
      ['codex', 'opencode', 'cursor', 'pi', 'claude-code'],
      approve,
    );
    const paths = getStatePaths(f.roots, 'project');
    const shared = join(paths.skillsDirectory, 'docs-check');
    const file = join(shared, 'SKILL.md');
    const initial = await lstat(file);
    const lock = await lstat(paths.lockPath);
    expect(
      await installer.add(
        client,
        await client.getPackage({ slug: 'docs' }),
        [],
        ['codex'],
        approve,
      ),
    ).toBe('unchanged');
    expect((await lstat(file)).mtimeMs).toBe(initial.mtimeMs);
    expect((await lstat(paths.lockPath)).mtimeMs).toBe(lock.mtimeMs);
    expect(
      (await readlink(join(f.roots.cwd, '.claude/skills/docs-check'))).replaceAll('\\', '/'),
    ).toBe('../../.agents/skills/docs-check');
    for (const name of ['.codex', '.opencode', '.cursor', '.pi'])
      await absent(join(f.roots.cwd, name));
    const global = new Installer(context, { scope: 'global', telemetry });
    await global.add(
      client,
      await client.getPackage({ slug: 'docs' }),
      [],
      ['claude-code'],
      approve,
    );
    const cwd = join(f.temporaryRoot, 'another-project');
    await mkdir(cwd);
    await new Installer(
      { ...context, roots: { ...f.roots, cwd } },
      { scope: 'project', telemetry },
    ).add(client, await client.getPackage({ slug: 'docs' }), [], ['codex'], approve);
    await telemetry.flush();
    expect(registry.requests.filter((path) => path.startsWith('/download/'))).toHaveLength(1);
    expect(registry.events.map(({ body }) => body.event)).toEqual([
      'download',
      'install',
      'install',
      'install',
    ]);
    const entry = join(
      f.roots.home,
      '.skills-installer/store',
      artifactKey(client, release.skills[0]!),
    );
    expect((await readdir(entry)).sort()).toEqual(['content', 'entry.json']);
    expect((await lstat(join(entry, 'content/SKILL.md'))).ino).not.toBe(initial.ino);
    await writeFile(file, 'project-only edit');
    for (const location of [
      join(entry, 'content'),
      join(cwd, '.agents/skills/docs-check'),
      join(f.roots.home, '.agents/skills/docs-check'),
    ]) {
      expect(await readFile(join(location, 'SKILL.md'), 'utf8')).toContain('Version 1.0.0');
    }
    await installer.remove('docs', [], [], approve);
    expect(await readdir(entry)).toContain('content');
    // Fresh metadata remains mandatory even with a complete cache entry.
    registry.failed.add('docs');
    await expect(client.getPackage({ slug: 'docs' })).rejects.toThrow('HTTP 503');
  });
});

it.each(['bytes', 'descriptor', 'missing', ...(process.platform === 'win32' ? [] : ['mode'])])(
  'repairs a damaged store entry (%s) before reuse',
  async (damage) => {
    await withTestEnvironment(async (f) => {
      const registry = new TestRegistry();
      registry.release('docs', '1.0.0', ['check']);
      const client = new RegistryClient(registry.url, registry.http);
      const release = await client.getPackage({ slug: 'docs' });
      const context = { ...f, http: registry.http };
      const installer = new Installer(context, { scope: 'project' });
      await installer.add(client, release, [], ['codex'], approve);
      const entry = join(
        f.roots.home,
        '.skills-installer/store',
        artifactKey(client, release.skills[0]!),
        'content',
      );
      if (damage === 'bytes') await writeFile(join(entry, 'SKILL.md'), 'broken');
      if (damage === 'descriptor') await writeFile(join(entry, 'component.json'), '{}');
      if (damage === 'missing') await rm(join(entry, 'SKILL.md'));
      if (damage === 'mode') await chmod(join(entry, 'scripts/run.sh'), 0o644);
      await new Installer(context, { scope: 'global' }).add(
        client,
        release,
        [],
        ['codex'],
        approve,
      );
      expect(registry.requests.filter((path) => path.startsWith('/download/'))).toHaveLength(2);
      expect(await readFile(join(entry, 'SKILL.md'), 'utf8')).toContain('1.0.0');
      expect(
        (await readdir(join(f.roots.home, '.skills-installer/store'))).filter((name) =>
          /\.lock$|\.tmp-/.test(name),
        ),
      ).toEqual([]);
    });
  },
);

it('repairs missing shared files and Claude link at the same version; reviews edits and refuses foreign objects', async () => {
  await withTestEnvironment(async (f) => {
    const registry = new TestRegistry();
    registry.release('docs', '1.0.0', ['check']);
    const client = new RegistryClient(registry.url, registry.http);
    const installer = new Installer({ ...f, http: registry.http }, { scope: 'project' });
    await installer.add(
      client,
      await client.getPackage({ slug: 'docs' }),
      [],
      ['claude-code'],
      approve,
    );
    const file = join(f.roots.cwd, '.agents/skills/docs-check/SKILL.md');
    const link = join(f.roots.cwd, '.claude/skills/docs-check');
    await rm(file);
    await rm(link);
    const result = await installer.update({ skills: [], agents: [] }, async (previews) => {
      expect(previews[0]?.version).toBe('1.0.0');
      return ['docs'];
    });
    expect(result.updated).toEqual(['docs']);
    expect(await readFile(join(link, 'SKILL.md'), 'utf8')).toContain('1.0.0');
    await writeFile(file, 'manual changes');
    expect(
      await installer.add(
        client,
        await client.getPackage({ slug: 'docs' }),
        [],
        ['claude-code'],
        async (preview) => {
          expect(preview.skills[0]?.modifiedPaths).toContain(
            join(f.roots.cwd, '.agents/skills/docs-check'),
          );
          return 'decline';
        },
      ),
    ).toBe('declined');
    expect(await readFile(file, 'utf8')).toBe('manual changes');
    await installer.add(
      client,
      await client.getPackage({ slug: 'docs' }),
      [],
      ['claude-code'],
      approve,
    );
    expect(registry.requests.filter((path) => path.startsWith('/download/'))).toHaveLength(1);
    await rm(link);
    await mkdir(link);
    await expect(
      installer.add(
        client,
        await client.getPackage({ slug: 'docs' }),
        [],
        ['claude-code'],
        approve,
      ),
    ).rejects.toThrow('чужим объектом');
  });
});

it('rolls back the whole package on symlink permission failure without making a fallback copy', async () => {
  await withTestEnvironment(async (f) => {
    const registry = new TestRegistry();
    registry.release('docs', '1.0.0', ['check']);
    const client = new RegistryClient(registry.url, registry.http);
    const installer = new Installer(
      { ...f, http: registry.http },
      {
        scope: 'project',
        fileSystem: {
          ...installerFileSystem,
          symlink: async () => {
            throw Object.assign(new Error('symlink denied'), { code: 'EPERM' });
          },
        },
      },
    );
    await expect(
      installer.add(
        client,
        await client.getPackage({ slug: 'docs' }),
        [],
        ['claude-code'],
        approve,
      ),
    ).rejects.toThrow('symlink denied');
    expect(await new StateStore(getStatePaths(f.roots, 'project')).read()).toBeNull();
    await absent(join(f.roots.cwd, '.agents/skills/docs-check'));
    await absent(join(f.roots.cwd, '.claude/skills/docs-check'));
  });
});

it('does not change the installed registry when the saved setting changes', async () => {
  await withTestEnvironment(async (f) => {
    const first = new TestRegistry('https://first.test');
    first.release('docs', '1.0.0', ['check']);
    const client = new RegistryClient(first.url, first.http);
    const context = { ...f, http: first.http };
    const installer = new Installer(context, { scope: 'project' });
    await installer.add(client, await client.getPackage({ slug: 'docs' }), [], ['codex'], approve);
    const { writeRegistryConfig } = await import('@/config');
    await writeRegistryConfig(f.roots, 'https://second.test');
    first.release('docs', '2.0.0', ['check']);
    const updated = new Installer(
      {
        ...context,
        http: async (input, init) => {
          expect(new URL(String(input)).origin).toBe(first.url);
          return first.http(input, init);
        },
      },
      { scope: 'project' },
    );
    expect(
      (await updated.update({ skills: [], agents: [] }, async () => ['docs'])).updated,
    ).toEqual(['docs']);
    expect((await installer.list())[0]?.registryUrl).toBe(first.url);
  });
});

it('keeps recovery directories for diagnosis and releases only its own scope lock', async () => {
  await withTestEnvironment(async (f) => {
    const registry = new TestRegistry();
    registry.release('docs', '1.0.0', ['check']);
    const client = new RegistryClient(registry.url, registry.http);
    const paths = getStatePaths(f.roots, 'project');
    const recovery = join(paths.agentsDirectory, '.skills-installer-work-recovery');
    await mkdir(recovery, { recursive: true });
    await writeFile(join(recovery, 'backup'), 'keep');
    const installer = new Installer({ ...f, http: registry.http }, { scope: 'project' });
    await expect(
      installer.add(client, await client.getPackage({ slug: 'docs' }), [], ['codex'], approve),
    ).rejects.toThrow('Остались каталоги восстановления');
    expect(await readFile(join(recovery, 'backup'), 'utf8')).toBe('keep');
    await absent(paths.operationLockPath);
    expect(registry.requests.filter((path) => path.startsWith('/download/'))).toEqual([]);
  });
});
