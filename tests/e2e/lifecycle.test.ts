import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeContext } from '@/runtime';
import { getStatePaths, StateStore } from '@/state';
import { withE2eRegistry } from '../helpers/e2e-registry.ts';
import { requireBuiltCli, runBuiltCli } from '../helpers/built-cli.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

beforeAll(requireBuiltCli);
const absent = (path: string) => expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });

async function command(context: RuntimeContext, args: string[], status = 0) {
  const result = await runBuiltCli(context, args);
  expect(result.status, result.stdout + result.stderr).toBe(status);
  if (!status) expect(result.stderr).toBe('');
  return result;
}

describe.each(['project', 'global'] as const)('built CLI registry lifecycle in %s', (scope) => {
  it('combines selected skills and connections, updates, downgrades without pin and removes offline', async () => {
    await withE2eRegistry(async (registry) => {
      registry.release('docs', '1.0.0', ['check', 'compare', 'format']);
      await withTestEnvironment(async (f) => {
        const context = {
          ...f,
          env: { ...f.env, SKILLS_API_URL: registry.url, DISABLE_TELEMETRY: '', DO_NOT_TRACK: '' },
        };
        const paths = getStatePaths(f.roots, scope);
        const store = new StateStore(paths);
        const flags = [scope === 'global' ? '-g' : '-p', '--yes'];
        const shared = (name: string) => join(paths.skillsDirectory, `docs-${name}`);
        const claude = (name: string) =>
          join(scope === 'project' ? f.roots.cwd : f.roots.home, '.claude/skills', `docs-${name}`);
        const agents = ['-a', 'codex', '-a', 'claude-code'];
        await command(context, [
          'add',
          'docs',
          '--skill',
          'check',
          '--skill',
          'compare',
          ...flags,
          ...agents,
        ]);
        expect((await store.read())?.packages[0]?.skills.map((item) => item.name)).toEqual([
          'check',
          'compare',
        ]);
        expect((await lstat(claude('check'))).isSymbolicLink()).toBe(true);
        await absent(shared('format'));
        expect(registry.events).toHaveLength(2);
        expect(
          registry.events.every(
            ({ body }) => body.components.map((item) => item.name).join() === 'check,compare',
          ),
        ).toBe(true);
        const before = await readFile(paths.lockPath, 'utf8');
        expect(before).not.toMatch(/signature|expires|policy/);
        const downloads = () =>
          registry.requests.filter((item) => item.startsWith('/download/')).length;
        expect(downloads()).toBe(2);
        const repeat = await command(context, [
          'add',
          'docs',
          '--skill',
          'check',
          'compare',
          ...flags,
          ...agents,
        ]);
        expect(repeat.stdout).toContain('Без изменений');
        expect(downloads()).toBe(2);
        expect(await readFile(paths.lockPath, 'utf8')).toBe(before);
        await command(context, ['add', 'docs', '--skill', 'format', ...flags, '-a', 'pi']);
        const count = registry.requests.length;
        const listed = await command(context, ['list', flags[0]!, '-a', 'pi']);
        expect(listed.stdout).toMatch(/docs\s+1\.0\.0[\s\S]*format\s+pi/);
        expect(listed.stdout).not.toContain('compare');
        expect(registry.requests).toHaveLength(count);

        registry.release('docs', '2.0.0', ['check', 'format', 'new']);
        await writeFile(join(claude('compare'), 'SKILL.md'), 'manual edit');
        const update = await command(context, [
          'update',
          'docs',
          '--skill',
          'check',
          ...flags,
          '-a',
          'codex',
        ]);
        expect(update.stdout).toMatch(/1\.0\.0 → 2\.0\.0[\s\S]*compare — удаление/);
        expect(update.stdout).toContain('Ручные правки будут потеряны');
        await absent(shared('compare'));
        await absent(claude('compare'));
        await absent(shared('new'));
        expect(await readFile(join(claude('check'), 'SKILL.md'), 'utf8')).toContain('2.0.0');
        expect(await readFile(join(shared('format'), 'SKILL.md'), 'utf8')).toContain('2.0.0');

        const rollback = await command(context, [
          'add',
          'docs@1.0.0',
          '--skill',
          'check',
          ...flags,
          '-a',
          'codex',
        ]);
        expect(rollback.stdout).toContain('2.0.0 → 1.0.0');
        expect(await readFile(join(shared('format'), 'SKILL.md'), 'utf8')).toContain('1.0.0');
        await absent(shared('compare'));
        await command(context, ['update', ...flags]);
        expect((await store.read())?.packages[0]?.version).toBe('2.0.0');

        const removing = registry.requests.length;
        await command(context, [
          'remove',
          'docs',
          '--skill',
          'check',
          ...flags,
          '-a',
          'claude-code',
        ]);
        await absent(claude('check'));
        expect(await readFile(join(shared('check'), 'SKILL.md'), 'utf8')).toContain('2.0.0');
        await command(context, ['remove', 'docs', '--skill', 'check', ...flags]);
        await absent(shared('check'));
        expect((await store.read())?.packages[0]?.version).toBe('2.0.0');
        await command(context, ['remove', 'docs', ...flags]);
        expect(registry.requests).toHaveLength(removing);
        expect((await store.read())?.packages).toEqual([]);
        await absent(shared('format'));
        await absent(paths.operationLockPath);
      });
    });
  });
});

it('uses find with a three-character query and reports same-name results with install commands', async () => {
  await withE2eRegistry(async (registry) => {
    registry.release('docs', '1.0.0', ['check']);
    registry.release('reports', '2.0.0', ['check']);
    await withTestEnvironment(async (f) => {
      const result = await command(f, ['find', 'CHE', '-y', '--registry', registry.url]);
      expect(result.stdout).toMatch(/check\s+docs\s+1\.0\.0[\s\S]*add docs@1\.0\.0 --skill check/);
      expect(result.stdout).toMatch(
        /check\s+reports\s+2\.0\.0[\s\S]*add reports@2\.0\.0 --skill check/,
      );
      expect(registry.requests).toEqual([
        '/api/v1/components?kind=skill&q=CHE&sort=popular&limit=10',
      ]);
      await absent(join(f.roots.cwd, '.agents'));
      expect(registry.events).toEqual([]);
    });
  });
});

it('keeps a failed bulk update unchanged, applies the other package and ignores telemetry failure', async () => {
  await withE2eRegistry(async (registry) => {
    registry.release('docs', '1.0.0', ['check']);
    registry.release('reports', '1.0.0', ['check']);
    registry.eventStatus = 503;
    await withTestEnvironment(async (f) => {
      const context = {
        ...f,
        env: { ...f.env, SKILLS_API_URL: registry.url, DISABLE_TELEMETRY: '', DO_NOT_TRACK: '' },
      };
      for (const slug of ['docs', 'reports']) {
        await command(context, ['add', slug, '-y', '-a', 'codex']);
        registry.release(slug, '2.0.0', ['check']);
      }
      registry.corrupt.add('docs/check');
      const result = await command(context, ['update', '-y'], 1);
      expect(result.stdout).toContain('Обновлён пакет reports');
      expect(result.stderr).toMatch(/docs.*SHA-256/);
      const lock = await new StateStore(getStatePaths(f.roots, 'project')).read();
      expect(lock?.packages.map((item) => [item.slug, item.version])).toEqual([
        ['docs', '1.0.0'],
        ['reports', '2.0.0'],
      ]);
    });
  });
});

it('removes the package when its entire installed selection disappears', async () => {
  await withE2eRegistry(async (registry) => {
    registry.release('docs', '1.0.0', ['check']);
    await withTestEnvironment(async (f) => {
      const context = {
        ...f,
        env: { ...f.env, SKILLS_API_URL: registry.url, DISABLE_TELEMETRY: '', DO_NOT_TRACK: '' },
      };
      const paths = getStatePaths(f.roots, 'project');
      await command(context, ['--without-stat', 'add', 'docs', '-y', '-a', 'codex']);
      registry.release('docs', '2.0.0', ['new']);
      const result = await command(context, ['update', 'docs', '-y', '--without-stat']);
      expect(result.stdout).toMatch(/1\.0\.0 → 2\.0\.0[\s\S]*check — удаление/);
      expect((await new StateStore(paths).read())?.packages).toEqual([]);
      await absent(join(paths.skillsDirectory, 'docs-check'));
      await absent(join(paths.skillsDirectory, 'docs-new'));
      expect(registry.events).toEqual([]);
    });
  });
});

it.each([
  ['add', 'docs'],
  ['add', 'docs', '-y'],
  ['add', 'docs', '-y', '-a', 'codex', '-p', '-g'],
  ['update'],
  ['update', '--skill', 'check', '-y'],
  ['remove'],
  ['remove', '-y'],
  ['find', '-y'],
  ['list', '-p', '-g'],
  ['add', './local', '-y', '-a', 'codex'],
])('rejects invalid CLI arguments without creating state: %j', async (...args) => {
  await withTestEnvironment(async (f) => {
    const result = await command(f, args, 1);
    expect(result.stderr).toContain('Ошибка:');
    await absent(join(f.roots.cwd, '.agents'));
  });
});

it('rejects malformed package structure and leaves managed files intact', async () => {
  await withTestEnvironment(async (f) => {
    const paths = getStatePaths(f.roots, 'project');
    const invalid = '{"version":1,"packages":"broken"}';
    const installed = join(paths.skillsDirectory, 'check');
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, 'SKILL.md'), 'manual content');
    await writeFile(paths.lockPath, invalid);
    const result = await command(f, ['remove', 'docs', '-y'], 1);
    expect(result.stderr).toContain('packages');
    expect(await readFile(paths.lockPath, 'utf8')).toBe(invalid);
    expect(await readFile(join(installed, 'SKILL.md'), 'utf8')).toBe('manual content');
    await absent(paths.operationLockPath);
  });
});
