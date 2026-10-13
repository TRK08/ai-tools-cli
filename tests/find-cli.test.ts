import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/cli/program.ts';
import { selectRegistrySkill } from '../src/cli/find-ui.ts';
import { RegistryClient } from '../src/registry/client.ts';
import { sortCatalog } from '../src/registry/catalog.ts';
import { hashDirectory } from '../src/state/hash.ts';
import { getStatePaths } from '../src/state/paths.ts';
import type { TelemetryEnvelope } from '../src/telemetry/client.ts';
import { catalogItem } from './helpers/discovery.ts';
import { runCli } from './helpers/cli.ts';
import { withTestEnvironment, type TestEnvironment } from './helpers/test-environment.ts';
import { json, withRegistryServer } from './helpers/registry.ts';
import { versionRegistry } from './helpers/versions.ts';

function terminal(inputTTY = true, outputTTY = true, columns = 110) {
  let rendered = '';
  const input = Object.assign(new PassThrough(), {
    isTTY: inputTTY,
    isRaw: false,
    setRawMode: vi.fn((raw: boolean) => {
      input.isRaw = raw;
    }),
  });
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        rendered += String(chunk);
        done();
      },
    }),
    { isTTY: outputTTY, columns, rows: 24 },
  );
  return {
    input,
    output,
    rendered: () => rendered,
    current: () => {
      const start = rendered.lastIndexOf('\u001b[J');
      return start < 0 ? rendered : rendered.slice(start + 3);
    },
    close() {
      input.destroy();
      output.destroy();
    },
  };
}
const tick = () => new Promise<void>((done) => setImmediate(done));
async function keys(t: ReturnType<typeof terminal>, ...sequence: string[]) {
  await tick();
  for (const key of sequence) {
    t.input.write(key);
    await tick();
  }
}
const searchReady = (t: ReturnType<typeof terminal>) =>
  vi.waitFor(() => expect(t.current()).toContain('Найдите скилл для установки'), { interval: 5 });
const resultsReady = (t: ReturnType<typeof terminal>, reference = 'demo@1.0.0') =>
  vi.waitFor(
    () => {
      expect(t.current()).toContain(reference);
      expect(t.current()).not.toContain('Поиск в реестре');
    },
    { interval: 5 },
  );
const agentReady = (t: ReturnType<typeof terminal>) =>
  vi.waitFor(() => expect(t.rendered()).toContain('Выберите агентов'), { interval: 5 });
const enter = '\r',
  down = '\u001b[B';

function catalogRegistry(f: TestEnvironment) {
  const backend = versionRegistry();
  const items = [
    catalogItem({ currentVersion: '1.0.0', installCount: 12 }),
    catalogItem({
      slug: 'other',
      name: 'UI Tools',
      shortDescription: 'Frontend components',
      tags: ['web'],
      currentVersion: '1.0.0',
      installCount: 30,
    }),
  ];
  const events: TelemetryEnvelope[] = [];
  const requests: string[] = [];
  const http = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (init?.method === 'POST') {
      events.push(JSON.parse(String(init.body)) as TelemetryEnvelope);
      return new Response(null, { status: 202 });
    }
    const parsed = new URL(url);
    if (parsed.pathname === '/origin/api/v1/skills')
      return Response.json({
        items: items.filter((item) =>
          item.slug.startsWith(parsed.searchParams.get('slugPrefix') ?? ''),
        ),
      });
    return backend.http(input, init);
  });
  const context = {
    ...f,
    env: { ...f.env, DISABLE_TELEMETRY: '', DO_NOT_TRACK: '', SKILLS_API_URL: backend.url },
    http,
  };
  return { ...backend, context, items, events, requests, http };
}

describe('backend live registry finder', () => {
  it('waits for two characters, clears rows when shortened and ignores Enter below the minimum', async () =>
    withTestEnvironment(async (f) => {
      const registry = catalogRegistry(f),
        t = terminal();
      try {
        let resolved = false;
        const selected = selectRegistrySkill(
          new RegistryClient(registry.url, registry.http),
          'd',
          t,
        ).then((value) => {
          resolved = true;
          return value;
        });
        await searchReady(t);
        expect(t.current()).toContain('Для поиска введите от 2 символов');
        await keys(t, enter);
        expect(registry.requests).toEqual([]);
        expect(resolved).toBe(false);
        await keys(t, 'e');
        await resultsReady(t);
        expect(registry.requests).toEqual([`${registry.url}/api/v1/skills?slugPrefix=de`]);
        await keys(t, '\u007f', enter);
        expect(t.current()).toContain('Для поиска введите от 2 символов');
        expect(t.current()).not.toContain('demo@1.0.0');
        expect(resolved).toBe(false);
        await keys(t, '\u001b');
        expect(await selected).toBeNull();
        expect(registry.requests).toHaveLength(1);
      } finally {
        t.close();
      }
    }));

  it('sorts by installs and slug without changing the catalog', () => {
    const items = ['z-last', 'b-middle', 'a-first'].map((slug) =>
      catalogItem({ slug, installCount: slug === 'z-last' ? 10 : 20 }),
    );
    expect(sortCatalog(items).map((s) => s.slug)).toEqual(['a-first', 'b-middle', 'z-last']);
    expect(items.map((s) => s.slug)).toEqual(['z-last', 'b-middle', 'a-first']);
  });

  it('installs the selected version with latest policy even when the registry current version changes', async () =>
    withTestEnvironment(async (f) => {
      const registry = catalogRegistry(f),
        t = terminal();
      try {
        // Both forms can be real local sources in add; find must retain its explicit registry identity.
        for (const name of ['demo', 'demo@1.0.0']) {
          const folder = join(f.roots.cwd, name);
          await mkdir(folder);
          await writeFile(
            join(folder, 'SKILL.md'),
            '---\nname: local-shadow\ndescription: Local\n---\n',
          );
        }
        const run = createProgram('0.1.0', registry.context, { write: vi.fn() }, t).parseAsync(
          ['find', '--yes'],
          { from: 'user' },
        );
        await searchReady(t);
        expect(registry.requests).toEqual([]);
        await keys(t, 'dem');
        await resultsReady(t);
        expect(t.rendered()).toContain('Совпадений: 1');
        expect(t.current()).toContain('demo@1.0.0 · 12 установок');
        expect(t.current()).not.toContain('API Contract Checker');
        expect(t.current()).not.toContain('Checks HTTP contracts');
        expect(registry.requests).toEqual([`${registry.url}/api/v1/skills?slugPrefix=dem`]);
        registry.current.demo = '2.0.0';
        await keys(t, enter);
        await vi.waitFor(() => expect(t.rendered()).toContain('Область установки'), {
          interval: 5,
        });
        await keys(t, enter);
        await agentReady(t);
        expect(registry.requests).toHaveLength(1);
        await keys(t, enter);
        await run;
        const record = JSON.parse(
          await readFile(join(f.roots.cwd, 'skills-installer-lock.json'), 'utf8'),
        ).skills.demo;
        expect(record).toMatchObject({
          source: { kind: 'registry', slug: 'demo', registryUrl: registry.url },
          policy: 'latest',
          version: '1.0.0',
          agents: ['claude-code', 'codex', 'opencode'],
        });
        expect(registry.requests).toContain(
          `${registry.url}/api/v1/skills/demo/artifact?version=1.0.0`,
        );
        expect(registry.events.map((e) => e.event)).toEqual(['download', 'install']);
        expect(registry.events[1]!.context).toMatchObject({
          operation: 'add',
          version: '1.0.0',
          status: 'success',
        });
        expect(await readFile(join(f.roots.cwd, 'demo', 'SKILL.md'), 'utf8')).toContain(
          'local-shadow',
        );
        expect(t.input.isRaw).toBe(false);
      } finally {
        t.close();
      }
    }));

  it.each(['project', 'global'] as const)(
    'uses initial query, explicit agents and --without-stat in %s scope',
    async (scope) =>
      withTestEnvironment(async (f) => {
        const registry = catalogRegistry(f),
          t = terminal();
        try {
          const flags = scope === 'global' ? ['-g'] : [];
          const run = createProgram('0.1.0', registry.context, { write: vi.fn() }, t).parseAsync(
            [
              'find',
              'dem',
              '-a',
              'pi',
              '-a',
              'pi',
              ...flags,
              '--without-stat',
              '--yes',
              '--registry',
              registry.url,
            ],
            { from: 'user' },
          );
          await searchReady(t);
          await resultsReady(t);
          expect(t.rendered()).toContain('dem');
          await keys(t, enter);
          if (scope === 'project') {
            await vi.waitFor(() => expect(t.rendered()).toContain('Область установки'), {
              interval: 5,
            });
            await keys(t, enter);
          }
          await run;
          const paths = getStatePaths(f.roots, scope),
            lock = JSON.parse(await readFile(paths.lockPath, 'utf8'));
          expect(lock.skills.demo).toMatchObject({
            version: '1.0.0',
            policy: 'latest',
            agents: ['pi'],
          });
          expect(t.rendered()).not.toContain('Выберите агентов');
          expect(registry.events).toEqual([]);
          registry.current.demo = '2.0.0';
          await createProgram('0.1.0', registry.context, { write: vi.fn() }, t).parseAsync(
            ['update', 'demo', '--yes', '--without-stat', ...flags],
            { from: 'user' },
          );
          expect(JSON.parse(await readFile(paths.lockPath, 'utf8')).skills.demo).toMatchObject({
            version: '2.0.0',
            policy: 'latest',
            agents: ['pi'],
          });
          expect(registry.requests).toContain(`${registry.url}/api/v1/skills/demo/artifact`);
          expect(registry.events).toEqual([]);
        } finally {
          t.close();
        }
      }),
  );

  it('scrolls beyond the first eight results with compact rows and no descriptions', async () =>
    withTestEnvironment(async () => {
      const t = terminal(true, true, 48);
      const items = Array.from({ length: 13 }, (_, i) =>
        catalogItem({
          slug: `skill-${String(i).padStart(2, '0')}`,
          installCount: 100 - i,
          shortDescription: 'Кириллица 🚀 ' + 'Long description '.repeat(8),
        }),
      );
      try {
        const chosen = selectRegistrySkill(
          new RegistryClient('https://registry.example.test', async () => Response.json({ items })),
          'skill-',
          t,
        );
        await searchReady(t);
        await resultsReady(t, 'skill-00@1.2.3');
        await keys(t, ...Array.from({ length: 12 }, () => down), enter);
        expect((await chosen)!.slug).toBe('skill-12');
        expect(t.rendered()).not.toContain('Кириллица 🚀');
        expect(t.rendered()).not.toContain('API Contract Checker');
      } finally {
        t.close();
      }
    }));

  it('does not submit with no matches and allows clearing/retyping without rendering extra metadata', async () =>
    withTestEnvironment(async (f) => {
      const registry = catalogRegistry(f),
        t = terminal();
      registry.items[0] = catalogItem({
        currentVersion: '1.0.0',
        name: 'Escaped\u001b[31m',
        shortDescription: 'Unicode 🚀',
      });
      try {
        let resolved = false;
        const selected = selectRegistrySkill(
          new RegistryClient(registry.url, registry.http),
          '',
          t,
        ).then((value) => {
          resolved = true;
          return value;
        });
        await searchReady(t);
        await keys(t, 'nomatch', enter);
        await vi.waitFor(
          () => expect(t.current()).toContain('Скиллы с таким префиксом не найдены'),
          { interval: 5 },
        );
        expect(resolved).toBe(false);
        expect(t.rendered()).toContain('Скиллы с таким префиксом не найдены');
        await keys(t, ...Array.from({ length: 7 }, () => '\u007f'), 'demo');
        await resultsReady(t);
        await keys(t, enter);
        await vi.waitFor(() => expect(resolved).toBe(true), { timeout: 1000, interval: 10 });
        expect((await selected)!.slug).toBe('demo');
        expect(t.rendered()).not.toContain('\u001b[31m');
        expect(t.rendered()).not.toContain('Unicode 🚀');
      } finally {
        t.close();
      }
    }));

  it.each(['\u001b', '\u0003'])(
    'cancels the finder with %j after read-only catalog loading',
    async (key) =>
      withTestEnvironment(async (f) => {
        const registry = catalogRegistry(f),
          t = terminal(),
          output = { write: vi.fn() };
        const before = await hashDirectory(f.temporaryRoot);
        try {
          const run = createProgram('0.1.0', registry.context, output, t).parseAsync(
            ['find', 'dem'],
            {
              from: 'user',
            },
          );
          await searchReady(t);
          await keys(t, key);
          await run;
          expect(output.write).toHaveBeenCalledWith('Отменено.');
          expect(registry.requests).toHaveLength(1);
          expect(registry.events).toEqual([]);
          expect(await hashDirectory(f.temporaryRoot)).toBe(before);
          expect(t.input.isRaw).toBe(false);
        } finally {
          t.close();
        }
      }),
  );

  it.each(['\u001b', '\u0003'])(
    'cancels agent selection with %j before metadata/download/events',
    async (key) =>
      withTestEnvironment(async (f) => {
        const registry = catalogRegistry(f),
          t = terminal();
        const before = await hashDirectory(f.temporaryRoot);
        try {
          const run = createProgram('0.1.0', registry.context, { write: vi.fn() }, t).parseAsync(
            ['find', 'dem', '-g'],
            { from: 'user' },
          );
          await searchReady(t);
          await resultsReady(t);
          await keys(t, enter);
          await agentReady(t);
          await keys(t, key);
          await run;
          expect(registry.requests).toEqual([`${registry.url}/api/v1/skills?slugPrefix=dem`]);
          expect(registry.events).toEqual([]);
          expect(await hashDirectory(f.temporaryRoot)).toBe(before);
          expect(t.input.isRaw).toBe(false);
        } finally {
          t.close();
        }
      }),
  );

  it.each(['\u001b', '\u0003'])('cancels slow loading with %j and aborts HTTP', async (key) =>
    withTestEnvironment(async (f) => {
      const t = terminal();
      let signal: AbortSignal | null | undefined;
      const http = vi.fn<typeof fetch>(async (_url, init) => {
        signal = init?.signal;
        return new Promise<Response>(() => {});
      });
      try {
        const output = { write: vi.fn() };
        const run = createProgram('0.1.0', { ...f, http }, output, t).parseAsync(['find', 'dem'], {
          from: 'user',
        });
        expect(t.rendered()).toContain('Поиск в реестре');
        await keys(t, key);
        await run;
        expect(signal?.aborted).toBe(true);
        expect(output.write).toHaveBeenCalledWith('Отменено.');
        expect(await readdir(f.roots.cwd)).toEqual([]);
        expect(t.input.isRaw).toBe(false);
      } finally {
        t.close();
      }
    }),
  );

  it.each([503, 'invalid', 'empty'] as const)(
    'handles %s catalog without starting installation',
    async (result) =>
      withTestEnvironment(async (f) => {
        const t = terminal(),
          output = { write: vi.fn() };
        const http = vi.fn<typeof fetch>(async () =>
          result === 503
            ? new Response(null, { status: 503 })
            : result === 'invalid'
              ? new Response('invalid JSON')
              : Response.json({ items: [] }),
        );
        try {
          const run = createProgram('0.1.0', { ...f, http }, output, t).parseAsync(
            ['find', 'dem'],
            {
              from: 'user',
            },
          );
          await vi.waitFor(
            () =>
              expect(t.current()).toContain(
                result === 'empty'
                  ? 'Скиллы с таким префиксом не найдены'
                  : 'Не удалось выполнить поиск',
              ),
            { interval: 5 },
          );
          if (result !== 'empty')
            expect(t.current()).not.toContain('Скиллы с таким префиксом не найдены');
          await keys(t, '\u001b');
          await run;
          expect(http).toHaveBeenCalledTimes(1);
          expect(await readdir(f.roots.cwd)).toEqual([]);
          expect(t.input.isRaw).toBe(false);
        } finally {
          t.close();
        }
      }),
  );

  it('blocks old selections while loading and retries errors before allowing a new selection', async () =>
    withTestEnvironment(async (f) => {
      const t = terminal();
      let pending!: (response: Response) => void;
      let otherRequests = 0,
        resolved = false;
      const http = vi.fn<typeof fetch>(async (input) => {
        const prefix = new URL(String(input)).searchParams.get('slugPrefix');
        if (prefix === 'dem')
          return Response.json({ items: [catalogItem({ currentVersion: '1.0.0' })] });
        if (++otherRequests === 1)
          return new Promise<Response>((done) => {
            pending = done;
          });
        return Response.json({ items: [catalogItem({ slug: 'other', currentVersion: '1.0.0' })] });
      });
      try {
        const selection = selectRegistrySkill(
          new RegistryClient('https://registry.example.test', http),
          'dem',
          t,
        ).then((value) => {
          resolved = true;
          return value;
        });
        await resultsReady(t);
        await keys(t, '\u0015', 'other', enter);
        expect(resolved).toBe(false);
        expect(t.current()).toContain('Поиск в реестре');
        expect(t.current()).not.toContain('demo@');
        await vi.waitFor(() => expect(otherRequests).toBe(1), { interval: 5 });
        pending(new Response(null, { status: 503 }));
        await vi.waitFor(() => expect(t.current()).toContain('Не удалось выполнить поиск'), {
          interval: 5,
        });
        expect(t.current()).not.toContain('Скиллы с таким префиксом не найдены');
        await keys(t, enter);
        await resultsReady(t, 'other@1.0.0');
        expect(resolved).toBe(false);
        await keys(t, enter);
        expect((await selection)!.slug).toBe('other');
        expect(http).toHaveBeenCalledTimes(3);
        expect(await readdir(f.roots.cwd)).toEqual([]);
      } finally {
        t.close();
      }
    }));

  it('protects modified copies and applies force through find', async () =>
    withTestEnvironment(async (f) => {
      const registry = catalogRegistry(f);
      const invoke = async (flags: string[], expectedFailure = false) => {
        const t = terminal();
        try {
          const run = createProgram('0.1.0', registry.context, { write: vi.fn() }, t).parseAsync(
            ['find', 'demo', '-a', 'codex', '--without-stat', '--yes', ...flags],
            { from: 'user' },
          );
          const settled = run.then(
            () => null,
            (error) => error as Error,
          );
          await searchReady(t);
          await resultsReady(t);
          await keys(t, enter);
          await vi.waitFor(() => expect(t.rendered()).toContain('Область установки'), {
            interval: 5,
          });
          await keys(t, enter);
          const error = await settled;
          if (expectedFailure) expect(error?.message).toContain('изменён локально');
          else expect(error).toBeNull();
        } finally {
          t.close();
        }
      };
      await invoke([]);
      const copy = join(f.roots.cwd, '.agents/skills/demo');
      await writeFile(join(copy, 'manual'), 'edit');
      await invoke([], true);
      expect(await readFile(join(copy, 'manual'), 'utf8')).toBe('edit');
      await invoke(['--force']);
      expect(await readdir(copy)).not.toContain('manual');
    }));

  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])('requires a query when TTY streams are %j / %j', async (inputTTY, outputTTY) =>
    withTestEnvironment(async (f) => {
      const t = terminal(inputTTY, outputTTY),
        http = vi.fn<typeof fetch>();
      try {
        await expect(
          createProgram('0.1.0', { ...f, http }, { write: vi.fn() }, t).parseAsync(['find'], {
            from: 'user',
          }),
        ).rejects.toThrow(/TTY.*find <slug-prefix>/);
        expect(http).not.toHaveBeenCalled();
        expect(t.rendered()).toBe('');
      } finally {
        t.close();
      }
    }),
  );

  it('validates unknown agents before HTTP even in the finder', async () =>
    withTestEnvironment(async (f) => {
      const t = terminal(),
        http = vi.fn<typeof fetch>();
      try {
        await expect(
          createProgram('0.1.0', { ...f, http }, { write: vi.fn() }, t).parseAsync(
            ['find', '-a', 'unknown'],
            { from: 'user' },
          ),
        ).rejects.toThrow('Неизвестный агент');
        expect(http).not.toHaveBeenCalled();
      } finally {
        t.close();
      }
    }));

  it.each(['d', '🚀'])('rejects short non-TTY prefix %j before HTTP', async (prefix) =>
    withTestEnvironment(async (f) => {
      const t = terminal(false, false),
        http = vi.fn<typeof fetch>();
      try {
        await expect(
          createProgram('0.1.0', { ...f, http }, { write: vi.fn() }, t).parseAsync(
            ['find', prefix],
            { from: 'user' },
          ),
        ).rejects.toThrow('длиной от 2 символов');
        expect(http).not.toHaveBeenCalled();
        expect(t.rendered()).toBe('');
      } finally {
        t.close();
      }
    }),
  );

  it('queries one slug prefix without TTY and rejects the old search command', async () =>
    withRegistryServer(
      async ({ url, requests }) =>
        withTestEnvironment(async (f) => {
          const result = await runCli(f, ['find', 'dem', '--registry', url, '-a', 'codex']);
          expect(result).toMatchObject({ status: 0, stderr: '' });
          expect(result.stdout).toContain('demo');
          expect(result.stdout).not.toContain('Выберите агентов');
          expect(await readdir(f.roots.cwd)).toEqual([]);
          expect(requests).toEqual(['/api/v1/skills?slugPrefix=dem']);
          const old = await runCli(f, ['search', 'api']);
          expect(old.status).toBe(1);
          expect(old.stderr).toContain('search');
          expect(requests).toHaveLength(1);
        }),
      (_req, res) => json(res, { items: [catalogItem()] }),
    ));
});
