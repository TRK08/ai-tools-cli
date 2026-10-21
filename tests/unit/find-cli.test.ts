import { RegistryFindSearch } from '../../src/cli/find-search.ts';
import { readdir } from 'node:fs/promises';

import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'fast-string-width';
import { S_RADIO_ACTIVE } from '@clack/prompts';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/program.ts';
import { selectRegistrySkill } from '../../src/cli/ui/find-ui.ts';
import { RegistryClient } from '../../src/registry/client.ts';
import { sortCatalog } from '../../src/registry/catalog.ts';
import { hashDirectory } from '../../src/state/hash.ts';

import type { TelemetryEnvelope } from '../../src/telemetry/client.ts';
import { catalogItem } from '../helpers/discovery.ts';

import { withTestEnvironment, type TestEnvironment } from '../helpers/test-environment.ts';

import { versionRegistry } from '../helpers/versions.ts';

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
          (changed) =>
            new RegistryFindSearch(new RegistryClient(registry.url, registry.http), changed),
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
          (changed) =>
            new RegistryFindSearch(
              new RegistryClient('https://registry.example.test', async () =>
                Response.json({ items }),
              ),
              changed,
            ),
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

  it('keeps the active long result visible in a bounded frame and returns its full identity', async () => {
    const t = terminal(true, true, 48);
    t.output.rows = 16;
    const items = Array.from({ length: 13 }, (_, i) =>
      catalogItem({
        slug: `demo-${String(i).padStart(2, '0')}-` + 'a'.repeat(100),
        currentVersion: '1.2.3-' + 'long'.repeat(20),
        installCount: 100 - i,
      }),
    );
    const chosen = selectRegistrySkill(
      (changed) =>
        new RegistryFindSearch(
          new RegistryClient('https://registry.example.test', async () => Response.json({ items })),
          changed,
        ),
      'demo',
      t,
    );
    try {
      await vi.waitFor(() => expect(t.current()).toContain('Совпадений: 13'));
      await keys(t, down, down);
      const frame = stripVTControlCharacters(t.current()).trimEnd().split('\n');
      expect(frame.some((line) => line.includes(`${S_RADIO_ACTIVE} demo-02-`))).toBe(true);
      expect(frame.length).toBeLessThanOrEqual(15);
      expect(frame.every((line) => stringWidth(line) <= 47)).toBe(true);
      expect(frame.some((line) => line.endsWith('…'))).toBe(true);
      await keys(t, ...Array.from({ length: 10 }, () => down));
      expect(stripVTControlCharacters(t.current())).toContain(`${S_RADIO_ACTIVE} demo-12-`);
      await keys(t, enter);
      expect((await chosen)?.slug).toBe(items[12]!.slug);
      expect((await chosen)?.currentVersion).toBe(items[12]!.currentVersion);
    } finally {
      t.input.write('\u001b');
      await chosen;
      t.close();
    }
  });

  it.each([18, 2])(
    'blocks submission at %i columns and preserves selection after recovery',
    async (columns) => {
      const t = terminal();
      const items = [catalogItem(), catalogItem({ slug: 'other' })];
      let resolved = false;
      const chosen = selectRegistrySkill(
        (changed) =>
          new RegistryFindSearch(
            new RegistryClient('https://registry.example.test', async () =>
              Response.json({ items }),
            ),
            changed,
          ),
        'de',
        t,
      ).then((value) => {
        resolved = true;
        return value;
      });
      try {
        await resultsReady(t, 'demo@1.2.3');
        await keys(t, down);
        t.output.rows = 4;
        t.output.columns = columns;
        t.output.emit('resize');
        await keys(t, enter);
        expect(resolved).toBe(false);
        const frame = stripVTControlCharacters(t.current());
        if (columns === 18) expect(frame).toContain('Увеличьте окно');
        expect(
          frame
            .trimEnd()
            .split('\n')
            .every((line) => stringWidth(line) <= columns - 1),
        ).toBe(true);
        t.output.rows = 8;
        t.output.columns = 28;
        t.output.emit('resize');
        expect(stripVTControlCharacters(t.current())).toContain(`${S_RADIO_ACTIVE} other@`);
        await keys(t, enter);
        expect((await chosen)?.slug).toBe('other');
      } finally {
        t.input.write('\u001b');
        await chosen;
        t.close();
      }
    },
  );

  it('scrolls the query around its cursor without changing the server prefix', async () => {
    const t = terminal(true, true, 48);
    t.output.rows = 8;
    const query = 'demo-' + 'x'.repeat(90) + 'tail';
    const prefixes: string[] = [];
    const chosen = selectRegistrySkill(
      (changed) =>
        new RegistryFindSearch(
          new RegistryClient('https://registry.example.test', async (input) => {
            prefixes.push(new URL(String(input)).searchParams.get('slugPrefix')!);
            return Response.json({ items: [catalogItem()] });
          }),
          changed,
        ),
      query,
      t,
    );
    try {
      await resultsReady(t, 'demo@1.2.3');
      expect(prefixes).toEqual([query]);
      expect(stripVTControlCharacters(t.current())).toContain('tail█');
      await keys(t, '\u0001');
      expect(stripVTControlCharacters(t.current())).toContain('█demo-');
      expect(
        stripVTControlCharacters(t.current())
          .trimEnd()
          .split('\n')
          .every((line) => stringWidth(line) <= 47),
      ).toBe(true);
      await keys(t, '\u0005');
      expect(stripVTControlCharacters(t.current())).toContain('tail█');
    } finally {
      t.input.write('\u001b');
      await chosen;
      t.close();
    }
  });

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
          (changed) =>
            new RegistryFindSearch(new RegistryClient(registry.url, registry.http), changed),
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
          t = terminal();
        const before = await hashDirectory(f.temporaryRoot);
        try {
          const run = createProgram({
            version: '0.1.0',
            runtime: registry.context,
            stdin: t.input,
            stdout: t.output,
            stderr: t.output,
          }).parseAsync(['find', 'dem'], {
            from: 'user',
          });
          await searchReady(t);
          await keys(t, key);
          await run;
          expect(t.rendered()).toContain('Отменено.');
          expect(registry.requests).toHaveLength(1);
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
        const run = createProgram({
          version: '0.1.0',
          runtime: { ...f, http },
          stdin: t.input,
          stdout: t.output,
          stderr: t.output,
        }).parseAsync(['find', 'dem'], {
          from: 'user',
        });
        expect(t.rendered()).toContain('Поиск в реестре');
        await keys(t, key);
        await run;
        expect(signal?.aborted).toBe(true);
        expect(t.rendered()).toContain('Отменено.');
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
        const t = terminal();
        const http = vi.fn<typeof fetch>(async () =>
          result === 503
            ? new Response(null, { status: 503 })
            : result === 'invalid'
              ? new Response('invalid JSON')
              : Response.json({ items: [] }),
        );
        try {
          const run = createProgram({
            version: '0.1.0',
            runtime: { ...f, http },
            stdin: t.input,
            stdout: t.output,
            stderr: t.output,
          }).parseAsync(['find', 'dem'], {
            from: 'user',
          });
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
          (changed) =>
            new RegistryFindSearch(
              new RegistryClient('https://registry.example.test', http),
              changed,
            ),
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
          createProgram({
            version: '0.1.0',
            runtime: { ...f, http },
            stdin: t.input,
            stdout: t.output,
            stderr: t.output,
          }).parseAsync(['find'], {
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
          createProgram({
            version: '0.1.0',
            runtime: { ...f, http },
            stdin: t.input,
            stdout: t.output,
            stderr: t.output,
          }).parseAsync(['find', '-a', 'unknown'], { from: 'user' }),
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
          createProgram({
            version: '0.1.0',
            runtime: { ...f, http },
            stdin: t.input,
            stdout: t.output,
            stderr: t.output,
          }).parseAsync(['find', prefix], { from: 'user' }),
        ).rejects.toThrow('длиной от 2 символов');
        expect(http).not.toHaveBeenCalled();
        expect(t.rendered()).toBe('');
      } finally {
        t.close();
      }
    }),
  );
});
