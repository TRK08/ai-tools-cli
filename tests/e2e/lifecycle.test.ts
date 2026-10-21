import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeContext } from '../../src/runtime.ts';
import { archiveBytes } from '../helpers/archive.ts';
import { withE2eRegistry } from '../helpers/e2e-registry.ts';
import { requireBuiltCli, runBuiltCli } from '../helpers/built-cli.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

beforeAll(requireBuiltCli);
type Scope = 'project' | 'global';
const bytes = Buffer.from([0, 255, 128, 13, 10]);
const text = (version: number) =>
  `---\nname: demo\ndescription: E2E fixture\n---\nVersion ${version}\n`;
const flags = (scope: Scope) => (scope === 'global' ? ['-g'] : []);
const root = (context: RuntimeContext, scope: Scope) =>
  scope === 'global' ? context.roots.home : context.roots.cwd;
const lockPath = (context: RuntimeContext, scope: Scope) =>
  join(
    root(context, scope),
    scope === 'global' ? '.agents/skills-installer-lock.json' : 'skills-installer-lock.json',
  );
const copies = (context: RuntimeContext, scope: Scope) =>
  ['.agents/skills/demo', '.claude/skills/demo'].map((path) => join(root(context, scope), path));

async function command(context: RuntimeContext, args: string[], status = 0) {
  const result = await runBuiltCli(context, args);
  expect(result.status, result.stdout + result.stderr).toBe(status);
  if (!status) expect(result.stderr).toBe('');
  return result;
}
async function lock(context: RuntimeContext, scope: Scope) {
  return JSON.parse(await readFile(lockPath(context, scope), 'utf8'));
}
async function clean(context: RuntimeContext, scope: Scope) {
  const agents = join(root(context, scope), '.agents');
  expect(
    (await readdir(agents)).filter((name) => name.startsWith('.skills-installer-work-')),
  ).toEqual([]);
  await expect(
    lstat(join(dirname(lockPath(context, scope)), '.skills-installer-operation.lock')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(
    (await readdir(dirname(lockPath(context, scope)))).filter(
      (name) => name.startsWith('.skills-installer-lock-') && name.endsWith('.tmp'),
    ),
  ).toEqual([]);
}
async function checkCopies(context: RuntimeContext, scope: Scope, expected: string) {
  for (const path of copies(context, scope))
    expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toContain(expected);
  expect((await lstat(copies(context, scope)[0]!)).isSymbolicLink()).toBe(false);
  expect((await lstat(copies(context, scope)[1]!)).isSymbolicLink()).toBe(scope === 'global');
  const other = scope === 'global' ? context.roots.cwd : context.roots.home;
  await expect(lstat(join(other, '.agents/skills/demo'))).rejects.toMatchObject({ code: 'ENOENT' });
  await clean(context, scope);
}

const add = (source: string, scope: Scope) => [
  'add',
  source,
  ...flags(scope),
  '-a',
  'codex',
  '-a',
  'claude-code',
  '--yes',
];

describe.each(['project', 'global'] as const)('built CLI registry lifecycle in %s', (scope) => {
  it(
    'finds, installs, repeats, updates, pins, unpins and removes through real HTTP',
    { timeout: 60_000 },
    async () => {
      await withE2eRegistry(async (registry) =>
        withTestEnvironment(async (f) => {
          const context = {
            ...f,
            env: {
              ...f.env,
              SKILLS_API_URL: 'http://127.0.0.1:1',
              DISABLE_TELEMETRY: '',
              DO_NOT_TRACK: '',
            },
          };
          const found = await command(context, ['find', 'dem', '--registry', registry.url]);
          expect(found.stdout).toContain('demo');
          expect(registry.requests).toEqual(['/api/v1/skills?slugPrefix=dem']);
          await expect(lstat(lockPath(context, scope))).rejects.toMatchObject({ code: 'ENOENT' });
          expect(registry.events).toEqual([]);
          await command(context, [...add('demo', scope), '--registry', registry.url]);
          await checkCopies(context, scope, 'Version 1.0.0');
          expect((await lock(context, scope)).skills.demo).toMatchObject({
            version: '1.0.0',
            policy: 'latest',
            source: { kind: 'registry', registryUrl: registry.url, slug: 'demo' },
          });
          expect(registry.events.map((event) => event.event).toSorted()).toEqual([
            'download',
            'install',
          ]);
          expect(registry.events.find((event) => event.event === 'install')!.context).toMatchObject(
            { operation: 'add', scope, status: 'success', agents: ['claude-code', 'codex'] },
          );
          const before = await readFile(lockPath(context, scope));
          expect(before.toString('utf8')).not.toMatch(/signature|e2e-secret|expires|\/download\//);
          const downloads = () =>
            registry.requests.filter((path) => path.startsWith('/download/')).length;
          const count = downloads(),
            events = registry.events.length;
          await command(context, [...add('demo', scope), '--registry', registry.url]);
          expect(downloads()).toBe(count);
          expect(registry.events).toHaveLength(events);
          expect(await readFile(lockPath(context, scope))).toEqual(before);
          const listed = await command(context, ['list', ...flags(scope)]);
          expect(listed.stdout).toMatch(/demo/);
          expect(listed.stdout).toContain('1.0.0');
          await command(context, [...add('demo@1.0.0', scope), '--registry', registry.url]);
          expect((await lock(context, scope)).skills.demo.policy).toBe('exact');
          await command(context, [...add('demo', scope), '--registry', registry.url]);
          expect((await lock(context, scope)).skills.demo.policy).toBe('latest');
          expect(downloads()).toBe(count);
          expect(registry.events).toHaveLength(events);
          await clean(context, scope);
          registry.state.latest = '2.0.0';
          await command(context, ['update', 'demo', ...flags(scope), '-a', 'codex', '--yes']);
          await checkCopies(context, scope, 'Version 2.0.0');
          expect(
            registry.events
              .slice(-2)
              .map((event) => [event.event, event.context.operation])
              .toSorted(),
          ).toEqual([
            ['download', 'update'],
            ['install', 'update'],
          ]);
          await command(context, [...add('demo@1.0.0', scope), '--registry', registry.url]);
          await checkCopies(context, scope, 'Version 1.0.0');
          expect((await lock(context, scope)).skills.demo.policy).toBe('exact');
          const requests = registry.requests.length;
          await command(context, ['update', 'demo', ...flags(scope), '--force', '--yes']);
          expect(registry.requests).toHaveLength(requests);
          await command(context, [...add('demo', scope), '--registry', registry.url]);
          expect((await lock(context, scope)).skills.demo.policy).toBe('latest');
          await checkCopies(context, scope, 'Version 2.0.0');
          await command(context, ['remove', 'demo', ...flags(scope), '-a', 'claude-code', '--yes']);
          expect((await lock(context, scope)).skills.demo.agents).toEqual(['codex']);
          await expect(lstat(copies(context, scope)[1]!)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await readFile(join(copies(context, scope)[0]!, 'SKILL.md'), 'utf8')).toContain(
            'Version 2.0.0',
          );
          const disabled = registry.events.length;
          await command(
            context,
            scope === 'project'
              ? ['--without-stat', ...add('demo', scope), '--registry', registry.url]
              : [...add('demo', scope), '--registry', registry.url, '--without-stat'],
          );
          expect((await lock(context, scope)).skills.demo.agents).toEqual(['claude-code', 'codex']);
          expect(registry.events).toHaveLength(disabled);
          const removing = registry.requests.length;
          await command(context, ['remove', 'demo', ...flags(scope), '--yes']);
          expect(registry.requests).toHaveLength(removing);
          expect((await lock(context, scope)).skills).toEqual({});
          for (const path of copies(context, scope))
            await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await readFile(lockPath(context, scope), 'utf8')).not.toMatch(
            /signature|expires|\/download\//,
          );
          await clean(context, scope);
        }),
      );
    },
  );
});

describe.each(['project', 'global'] as const)('built CLI local lifecycle in %s', (scope) => {
  it(
    'adds, updates and removes a directory preserving complex paths, binary resources and the source',
    { timeout: 30_000 },
    async () => {
      await withTestEnvironment(async (f) => {
        const cwd = join(f.temporaryRoot, 'Проект & (проверка) %PATH% ! ^'),
          source = join(f.temporaryRoot, 'Источник & (скилл) %PATH% ! ^');
        await mkdir(cwd);
        await mkdir(source);
        await writeFile(join(source, 'SKILL.md'), text(1));
        await writeFile(join(source, 'ресурс.bin'), bytes);
        const context = { ...f, roots: { ...f.roots, cwd } };
        await command(context, add(source, scope));
        await checkCopies(context, scope, text(1));
        for (const path of copies(context, scope))
          expect(await readFile(join(path, 'ресурс.bin'))).toEqual(bytes);
        const before = await readFile(lockPath(context, scope));
        await writeFile(join(source, 'SKILL.md'), text(2));
        if (scope === 'project') {
          await writeFile(join(copies(context, scope)[1]!, 'SKILL.md'), 'manual edits');
          await command(context, ['update', 'demo', '--yes'], 1);
          expect(await readFile(lockPath(context, scope))).toEqual(before);
          expect(await readFile(join(copies(context, scope)[1]!, 'SKILL.md'), 'utf8')).toBe(
            'manual edits',
          );
          expect(await readFile(join(copies(context, scope)[0]!, 'SKILL.md'), 'utf8')).toBe(
            text(1),
          );
        }
        await command(context, [
          'update',
          'demo',
          ...flags(scope),
          '--yes',
          ...(scope === 'project' ? ['--force'] : []),
        ]);
        await checkCopies(context, scope, text(2));
        expect((await lock(context, scope)).skills.demo.policy).toBe('local');
        expect((await command(context, ['list', ...flags(scope)])).stdout).toContain('demo');
        await command(context, ['remove', 'demo', ...flags(scope), '--yes']);
        for (const path of copies(context, scope))
          await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await lock(context, scope)).skills).toEqual({});
        expect(await readFile(join(source, 'SKILL.md'), 'utf8')).toBe(text(2));
        expect(await readFile(join(source, 'ресурс.bin'))).toEqual(bytes);
        await clean(context, scope);
      });
    },
  );
  it(
    'adds, updates and removes an archive with persisted identity and cleanup',
    { timeout: 30_000 },
    async () => {
      await withTestEnvironment(async (f) => {
        const source = join(f.roots.cwd, scope === 'project' ? 'Скилл.tgz' : 'Скилл.tar.gz');
        const archive = (version: number) =>
          archiveBytes([
            { path: 'outer/SKILL.md', contents: text(version) },
            { path: 'outer/ресурс.bin', contents: bytes },
          ]);
        await writeFile(source, archive(1));
        await command(f, add(source, scope));
        await checkCopies(f, scope, text(1));
        const previous = (await lock(f, scope)).skills.demo;
        expect(previous.source.kind).toBe('archive');
        expect(previous.version).toBeNull();
        await writeFile(source, archive(2));
        await command(f, ['update', 'demo', ...flags(scope), '--yes']);
        await checkCopies(f, scope, text(2));
        const next = (await lock(f, scope)).skills.demo;
        expect(next.source).toEqual(previous.source);
        expect(next.archiveHash).not.toBe(previous.archiveHash);
        for (const path of copies(f, scope))
          expect(await readFile(join(path, 'ресурс.bin'))).toEqual(bytes);
        await command(f, ['remove', 'demo', ...flags(scope), '--yes']);
        for (const path of copies(f, scope))
          await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await lock(f, scope)).skills).toEqual({});
        expect(await readFile(source)).toEqual(archive(2));
        await clean(f, scope);
      });
    },
  );
});

it(
  'preserves both copies and lock after a corrupt registry update',
  { timeout: 30_000 },
  async () => {
    await withE2eRegistry(async (registry) =>
      withTestEnvironment(async (f) => {
        const context = { ...f, env: { ...f.env, SKILLS_API_URL: registry.url } };
        await command(context, add('demo', 'project'));
        const before = await readFile(lockPath(context, 'project'));
        const contents = await Promise.all(
          copies(context, 'project').map((path) => readFile(join(path, 'SKILL.md'))),
        );
        registry.state.latest = '2.0.0';
        registry.state.corruptDownload = true;
        await command(context, ['update', 'demo', '--yes'], 1);
        expect(await readFile(lockPath(context, 'project'))).toEqual(before);
        expect(
          await Promise.all(
            copies(context, 'project').map((path) => readFile(join(path, 'SKILL.md'))),
          ),
        ).toEqual(contents);
        await clean(context, 'project');
      }),
    );
  },
);
it(
  'keeps files, lock and exit status when telemetry returns HTTP 503',
  { timeout: 30_000 },
  async () => {
    await withE2eRegistry(async (registry) =>
      withTestEnvironment(async (f) => {
        registry.state.telemetryStatus = 503;
        const context = {
          ...f,
          env: {
            ...f.env,
            SKILLS_API_URL: registry.url,
            SKILLS_TELEMETRY_ENDPOINT: `${registry.url}/custom-events`,
            DISABLE_TELEMETRY: '',
            DO_NOT_TRACK: '',
          },
        };
        await command(context, add('demo', 'project'));
        await checkCopies(context, 'project', 'Version 1.0.0');
        expect(registry.events.map((event) => event.event).toSorted()).toEqual([
          'download',
          'install',
        ]);
        expect(registry.requests).toContain('/custom-events');
        expect(registry.requests).not.toContain('/api/v1/skills/events');
        expect((await lock(context, 'project')).skills.demo.version).toBe('1.0.0');
      }),
    );
  },
);
