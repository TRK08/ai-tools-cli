import { access, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { parseAgents } from '@/agents';
import type { AgentDefinition } from '@/agents/catalog';
import { Installer } from '@/installer';
import { RegistryClient } from '@/registry';
import { getStatePaths, StateStore } from '@/state';
import { parseLockFile, serializeLockFile } from '@/state/schema';
import { defaultStateFileIO } from '@/state/store';
import { TestRegistry } from '../helpers/registry.ts';
import { withTestEnvironment, type TestEnvironment } from '../helpers/test-environment.ts';

vi.mock('@/agents/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/catalog')>();
  // Меняем только изолированный каталог теста, чтобы его функции также видели новый ID.
  (actual.AGENTS as unknown as AgentDefinition[]).push({
    id: 'example-agent',
    label: 'Example agent',
    helpOrder: 5,
    project: { kind: 'link', directory: (roots) => join(roots.cwd, '.example/skills') },
    global: { kind: 'link', directory: (roots) => join(roots.home, '.example/skills') },
  });
  return actual;
});

const agents = parseAgents(['example-agent']);
const approve = async () => 'approve' as const;

/** Создаёт новый Installer для каждого вызова, проверяя восстановление состояния с диска. */
function setup(f: TestEnvironment) {
  const registry = new TestRegistry();
  registry.release('docs', '1.0.0', ['check']);
  const client = new RegistryClient(registry.url, registry.http);
  const context = { ...f, http: registry.http };
  const installer = () => new Installer(context, { scope: 'project' });
  const add = async (target = installer()) =>
    target.add(client, await client.getPackage({ slug: 'docs' }), [], agents, approve);
  return {
    registry,
    context,
    installer,
    add,
    paths: getStatePaths(f.roots, 'project'),
    link: join(f.roots.cwd, '.example/skills/docs-check'),
  };
}

it('runs add → lock roundtrip → list → update → remove for a catalog-only agent', async () => {
  await withTestEnvironment(async (f) => {
    const { add, installer, registry, paths, link } = setup(f);
    await add();
    const raw = await readFile(paths.lockPath, 'utf8');
    const parsed = parseLockFile(JSON.parse(raw), paths);
    expect(serializeLockFile(parsed, paths)).toBe(raw);
    expect(parsed.packages[0]?.skills[0]?.connections).toEqual([
      { agent: 'example-agent', kind: 'link', path: '.example/skills/docs-check' },
    ]);
    expect((await readlink(link)).replaceAll('\\', '/')).toBe('../../.agents/skills/docs-check');
    expect(await installer().list()).toEqual(parsed.packages);
    registry.release('docs', '2.0.0', ['check']);
    expect(await installer().update({ skills: [], agents }, async () => ['docs'])).toEqual({
      updated: ['docs'],
      failures: [],
      cancelled: false,
    });
    expect(await readFile(join(link, 'SKILL.md'), 'utf8')).toContain('2.0.0');
    expect((await new StateStore(paths).read())?.packages[0]?.version).toBe('2.0.0');
    await installer().remove('docs', [], agents, approve);
    expect(await installer().list()).toEqual([]);
    await expect(access(link)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(paths.skillsDirectory, 'docs-check'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

it.each([
  { path: '.claude/skills/docs-check', kind: 'link' },
  { path: '../.example/skills/docs-check', kind: 'link' },
  { path: '.example/skills/other', kind: 'link' },
  { path: '.agents/skills/docs-check', kind: 'link' },
  { path: '.example/skills/docs-check', kind: 'direct' },
])('rejects an invalid catalog agent connection %j', async (connection) => {
  await withTestEnvironment(async (f) => {
    const { add, paths } = setup(f);
    await add();
    const raw = JSON.parse(await readFile(paths.lockPath, 'utf8'));
    Object.assign(raw.packages[0].skills[0].connections[0], connection);
    expect(() => parseLockFile(raw, paths)).toThrowError(
      expect.objectContaining({ code: 'INVALID_LOCK' }),
    );
  });
});

it.each([false, true])(
  'rolls back the extra agent on failed lock commit (installed=%s)',
  async (installed) => {
    await withTestEnvironment(async (f) => {
      const { add, context, registry, paths, link } = setup(f);
      if (installed) await add();
      const before = installed ? await readFile(paths.lockPath) : undefined;
      registry.release('docs', '2.0.0', ['check']);
      const broken = new Installer(context, {
        scope: 'project',
        stateIO: {
          ...defaultStateFileIO,
          rename: async () => {
            throw new Error('injected commit');
          },
        },
      });
      await expect(add(broken)).rejects.toThrow('injected commit');
      if (installed) {
        expect(await readFile(paths.lockPath)).toEqual(before);
        expect(await readFile(join(link, 'SKILL.md'), 'utf8')).toContain('1.0.0');
        expect((await readlink(link)).replaceAll('\\', '/')).toBe(
          '../../.agents/skills/docs-check',
        );
      } else {
        await expect(access(paths.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(access(link)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(access(join(paths.skillsDirectory, 'docs-check'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      await expect(access(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  },
);

it('preserves a foreign object at the catalog agent destination', async () => {
  await withTestEnvironment(async (f) => {
    const { add, link, paths } = setup(f);
    await mkdir(link, { recursive: true });
    await writeFile(join(link, 'mine'), 'foreign');
    await expect(add()).rejects.toThrow(/чужим объектом/);
    expect(await readFile(join(link, 'mine'), 'utf8')).toBe('foreign');
    await expect(access(paths.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
