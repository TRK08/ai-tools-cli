import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { executeCli } from '@/cli/run';
import { StateStore, getStatePaths } from '@/state';
import type { RuntimeContext } from '@/runtime';
import { TestRegistry } from '../helpers/registry.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';
import { terminal } from '../helpers/terminal.ts';

function cli(runtime: RuntimeContext, tty = true) {
  const t = terminal(tty, tty);
  const run = (args: string[]) =>
    executeCli(
      {
        version: 'test',
        runtime,
        stdin: t.input,
        stdout: t.output,
        stderr: t.output,
      },
      args,
    );
  const wait = (text: string) => vi.waitFor(() => expect(t.rendered()).toContain(text));
  const key = (name: string, character = '') => t.input.emit('keypress', character, { name });
  return { ...t, run, wait, key };
}

it('resolves the release before scope → skill → agents → summary and installs only checked skills', async () => {
  const registry = new TestRegistry();
  registry.release('docs', '1.0.0', ['check', 'compare']);
  await withTestEnvironment(async (f) => {
    let finishRequest!: () => void;
    const ready = new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    const t = cli({
      ...f,
      http: async (input, init) => {
        const response = await registry.http(input, init);
        await ready;
        return response;
      },
      env: { ...f.env, SKILLS_API_URL: registry.url },
    });
    try {
      const running = t.run(['add', 'docs']);
      await vi.waitFor(() => expect(registry.requests).toEqual(['/api/v1/packages/docs']));
      expect(t.rendered()).not.toContain('Область установки');
      finishRequest();
      await t.wait('Область установки');
      expect(registry.requests).toEqual(['/api/v1/packages/docs']);
      t.key('return');
      await t.wait('Выберите скиллы пакета');
      expect(registry.requests).toEqual(['/api/v1/packages/docs']);
      t.key('space', ' ');
      t.key('return');
      await t.wait('Всегда включены');
      t.key('space', ' ');
      t.key('return');
      await t.wait('Установить docs?');
      expect(registry.requests).toHaveLength(1);
      t.key('right');
      t.key('return');
      expect(await running).toBe(0);
      expect(registry.requests.filter((url) => url === '/api/v1/packages/docs')).toHaveLength(1);
      const lock = await new StateStore(getStatePaths(f.roots, 'project')).read();
      expect(lock?.packages[0]?.skills.map((item) => item.name)).toEqual(['compare']);
      expect(lock?.packages[0]?.skills[0]?.connections.map((item) => item.agent)).toEqual([
        'claude-code',
        'codex',
        'cursor',
        'opencode',
        'pi',
      ]);
      expect(t.input.isRaw).toBe(false);
    } finally {
      t.close();
    }
  });
});

it('checks the exact search selection before scope and installs it even if current changes', async () => {
  const registry = new TestRegistry();
  registry.release('docs', '1.0.0', ['check']);
  registry.release('reports', '1.2.0', ['check', 'print']);
  await withTestEnvironment(async (f) => {
    const t = cli({ ...f, http: registry.http, env: { ...f.env, SKILLS_API_URL: registry.url } });
    try {
      const running = t.run(['find', 'check', '-a', 'codex']);
      await t.wait('check · reports@1.2.0');
      await t.wait('check · docs@1.0.0');
      registry.release('reports', '2.0.0', ['check', 'print']);
      t.key('down');
      t.key('return');
      await t.wait('Область установки');
      expect(registry.requests.filter((url) => url.startsWith('/api/v1/packages/'))).toEqual([
        '/api/v1/packages/reports?version=1.2.0',
      ]);
      t.key('return');
      await t.wait('Установить reports?');
      t.key('right');
      t.key('return');
      expect(await running).toBe(0);
      const lock = await new StateStore(getStatePaths(f.roots, 'project')).read();
      expect(
        lock?.packages.map((item) => [
          item.slug,
          item.version,
          item.skills.map((skill) => skill.name),
        ]),
      ).toEqual([['reports', '1.2.0', ['check']]]);
      expect(
        registry.requests.filter((url) => url === '/api/v1/packages/reports?version=1.2.0'),
      ).toHaveLength(1);
    } finally {
      t.close();
    }
  });
});

it.each([
  'missing package',
  'missing version',
  'blocked release',
  'unavailable registry',
  'network error',
  'invalid JSON',
  'invalid release',
  'empty release',
  'missing skill',
] as const)('rejects %s before installation prompts or filesystem changes', async (scenario) => {
  const registry = new TestRegistry();
  registry.release('docs', '1.0.0', scenario === 'empty release' ? [] : ['check']);
  const http = vi.fn<RuntimeContext['http']>(async (input, init) => {
    if (scenario === 'blocked release') return new Response(null, { status: 410 });
    if (scenario === 'unavailable registry') return new Response(null, { status: 503 });
    if (scenario === 'network error') throw new TypeError('fetch failed');
    if (scenario === 'invalid JSON') return new Response('{');
    if (scenario === 'invalid release') return Response.json({});
    return registry.http(input, init);
  });
  const messages = {
    'missing package': 'Пакет missing не найден (HTTP 404)',
    'missing version': 'Пакет docs@2.0.0 не найден (HTTP 404)',
    'blocked release': 'HTTP 410: релиз заблокирован',
    'unavailable registry': 'HTTP 503',
    'network error': 'Запрос к реестру завершился ошибкой или превысил время ожидания',
    'invalid JSON': 'Реестр вернул некорректный JSON',
    'invalid release': 'Некорректный ответ реестра',
    'empty release': 'В релизе docs@1.0.0 нет скиллов',
    'missing skill': 'Скилл absent отсутствует в релизе docs@1.0.0',
  };
  await withTestEnvironment(async (f) => {
    const t = cli({ ...f, http, env: { ...f.env, SKILLS_API_URL: registry.url } });
    try {
      const input =
        scenario === 'missing package'
          ? 'missing'
          : scenario === 'missing version'
            ? 'docs@2.0.0'
            : 'docs';
      const args = ['add', input, ...(scenario === 'missing skill' ? ['--skill', 'absent'] : [])];
      expect(await t.run(args)).toBe(1);
      expect(t.rendered()).toContain(messages[scenario]);
      expect(t.rendered()).not.toMatch(
        /Область установки|Выберите скиллы пакета|Всегда включены|Установить docs\?/,
      );
      expect(http).toHaveBeenCalledTimes(1);
      expect(registry.events).toEqual([]);
      expect(t.input.isRaw).toBe(false);
      expect(t.input.listenerCount('keypress')).toBe(0);
      for (const root of [f.roots.cwd, f.roots.home])
        await expect(access(join(root, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(getStatePaths(f.roots, 'project').lockPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(access(join(f.roots.home, '.skills-installer/store'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      t.close();
    }
  });
});

it.each([
  ['add', 'docs', '-p', '-g'],
  ['add', 'docs', '-a', 'unknown'],
  ['add', 'docs', '-y'],
  ['add', './local'],
  ['add', 'docs@invalid'],
])('rejects invalid arguments before HTTP or scope selection: %j', async (...args) => {
  await withTestEnvironment(async (f) => {
    const http = vi.fn<RuntimeContext['http']>();
    const t = cli({ ...f, http, env: { ...f.env, SKILLS_API_URL: 'https://registry.test' } });
    try {
      expect(await t.run(args)).toBe(1);
      expect(t.rendered()).toContain('Ошибка:');
      expect(t.rendered()).not.toContain('Область установки');
      expect(http).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });
});

it.each([
  { tty: true, yes: false },
  { tty: true, yes: true },
  { tty: false, yes: false },
])('uses one fixed popular page in find with %j', async ({ tty, yes }) => {
  const registry = new TestRegistry();
  registry.release(
    'docs',
    '1.0.0',
    Array.from({ length: 30 }, (_, i) => `document-${String(i).padStart(2, '0')}`),
  );
  registry.releases.get('docs@1.0.0')![29]!.wire.installCount = 100;
  await withTestEnvironment(async (f) => {
    const t = cli(
      { ...f, http: registry.http, env: { ...f.env, SKILLS_API_URL: registry.url } },
      tty,
    );
    try {
      const running = t.run(['find', 'document', ...(yes ? ['--yes'] : [])]);
      if (tty && !yes) {
        await t.wait('Найдено: 30 · Показано: 10');
        expect(t.rendered()).toMatch(/document-29 · docs@1\.0\.0[\s\S]*document-00 · docs@1\.0\.0/);
        t.key('escape');
      }
      expect(await running).toBe(0);
      if (!tty || yes) {
        expect(t.rendered()).toContain('Найдено: 30. Показано: 10.');
        expect(t.rendered().match(/^document-\d{2}  docs  1\.0\.0$/gm)).toEqual(
          [29, 0, 1, 2, 3, 4, 5, 6, 7, 8].map(
            (i) => `document-${String(i).padStart(2, '0')}  docs  1.0.0`,
          ),
        );
      }
      expect(registry.requests).toEqual([
        '/api/v1/components?kind=skill&q=document&sort=popular&limit=10',
      ]);
      expect(t.input.isRaw).toBe(false);
    } finally {
      t.close();
    }
  });
});

it('rejects a search release removed after selection before opening installation prompts', async () => {
  const registry = new TestRegistry();
  registry.release('docs', '1.0.0', ['check']);
  await withTestEnvironment(async (f) => {
    const t = cli({ ...f, http: registry.http, env: { ...f.env, SKILLS_API_URL: registry.url } });
    try {
      const running = t.run(['find', 'check']);
      await t.wait('check · docs@1.0.0');
      registry.releases.delete('docs@1.0.0');
      t.key('return');
      expect(await running).toBe(1);
      expect(t.rendered()).toContain('Пакет docs@1.0.0 не найден (HTTP 404)');
      expect(t.rendered()).not.toMatch(/Область установки|Всегда включены|Установить docs\?/);
      expect(registry.requests).toEqual([
        '/api/v1/components?kind=skill&q=check&sort=popular&limit=10',
        '/api/v1/packages/docs?version=1.0.0',
      ]);
      expect(t.input.isRaw).toBe(false);
      expect(t.input.listenerCount('keypress')).toBe(0);
      await expect(access(join(f.roots.cwd, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      t.close();
    }
  });
});

it('shows manual changes before interactive remove and preserves files on cancellation', async () => {
  const registry = new TestRegistry();
  registry.release('docs', '1.0.0', ['check']);
  await withTestEnvironment(async (f) => {
    const t = cli({ ...f, http: registry.http, env: { ...f.env, SKILLS_API_URL: registry.url } });
    try {
      expect(await t.run(['add', 'docs', '-a', 'claude-code', '-y'])).toBe(0);
      const skill = join(f.roots.cwd, '.claude/skills/docs-check/SKILL.md');
      await writeFile(skill, 'manual');
      const requests = registry.requests.length;
      const removing = t.run(['remove', '-p']);
      await t.wait('Выберите пакет');
      t.key('return');
      await t.wait('Выберите скиллы для удаления');
      t.key('return');
      await t.wait('Выберите подключения для удаления');
      t.key('return');
      await t.wait('Ручные правки будут потеряны');
      t.key('escape');
      expect(await removing).toBe(0);
      expect(t.rendered()).toContain('Отменено.');
      expect(await readFile(skill, 'utf8')).toBe('manual');
      expect(registry.requests).toHaveLength(requests);
    } finally {
      t.close();
    }
  });
});

it('selects update scope then checks the locked registry before choosing packages', async () => {
  const registry = new TestRegistry();
  registry.release('docs', '1.0.0', ['check']);
  registry.release('reports', '1.0.0', ['check']);
  await withTestEnvironment(async (f) => {
    const http = vi.fn(registry.http);
    const env = { ...f.env, SKILLS_API_URL: registry.url };
    const t = cli({ ...f, http, env });
    try {
      for (const pkg of ['docs', 'reports'])
        expect(await t.run(['add', pkg, '-a', 'codex', '-y'])).toBe(0);
      registry.release('docs', '2.0.0', ['check']);
      registry.release('reports', '2.0.0', ['check']);
      env.SKILLS_API_URL = 'https://another-registry.test';
      registry.requests.length = 0;
      http.mockClear();
      const updating = t.run(['update']);
      await t.wait('Область установки');
      expect(http).not.toHaveBeenCalled();
      t.key('return');
      await t.wait('Выберите пакеты для обновления');
      expect(registry.requests).toEqual(['/api/v1/packages/docs', '/api/v1/packages/reports']);
      expect(http.mock.calls.map(([url]) => new URL(String(url)).origin)).toEqual([
        registry.url,
        registry.url,
      ]);
      t.key('space', ' ');
      t.key('return');
      await t.wait('Применить обновления?');
      t.key('y', 'y');
      expect(await updating).toBe(0);
      const lock = await new StateStore(getStatePaths(f.roots, 'project')).read();
      expect(lock?.packages.map((item) => [item.slug, item.version])).toEqual([
        ['docs', '1.0.0'],
        ['reports', '2.0.0'],
      ]);
    } finally {
      t.close();
    }
  });
});

it.each(['named', 'bulk'] as const)(
  'handles a missing update release before review in %s mode',
  async (mode) => {
    const registry = new TestRegistry();
    registry.release('docs', '1.0.0', ['check']);
    registry.release('reports', '1.0.0', ['check']);
    await withTestEnvironment(async (f) => {
      const t = cli({ ...f, http: registry.http, env: { ...f.env, SKILLS_API_URL: registry.url } });
      try {
        for (const pkg of ['docs', 'reports'])
          expect(await t.run(['add', pkg, '-a', 'codex', '-y'])).toBe(0);
        registry.current.delete('docs');
        registry.release('reports', '2.0.0', ['check']);
        registry.requests.length = 0;
        const before = await readFile(getStatePaths(f.roots, 'project').lockPath, 'utf8');
        const running = t.run(['update', ...(mode === 'named' ? ['docs'] : []), '-p']);
        if (mode === 'bulk') {
          await t.wait('Выберите пакеты для обновления');
          expect(registry.requests).toEqual(['/api/v1/packages/docs', '/api/v1/packages/reports']);
          t.key('return');
          await t.wait('Применить обновления?');
          t.key('y', 'y');
        }
        expect(await running).toBe(1);
        expect(t.rendered()).toContain('Пакет docs не найден (HTTP 404)');
        if (mode === 'named') {
          expect(t.rendered()).not.toMatch(/Выберите пакеты для обновления|Применить обновления\?/);
          expect(registry.requests).toEqual(['/api/v1/packages/docs']);
          expect(await readFile(getStatePaths(f.roots, 'project').lockPath, 'utf8')).toBe(before);
        }
        const lock = await new StateStore(getStatePaths(f.roots, 'project')).read();
        expect(lock?.packages.map((item) => [item.slug, item.version])).toEqual([
          ['docs', '1.0.0'],
          ['reports', mode === 'bulk' ? '2.0.0' : '1.0.0'],
        ]);
      } finally {
        t.close();
      }
    });
  },
);

it('cancels a pending release request, closing the terminal and leaving the project untouched', async () => {
  await withTestEnvironment(async (f) => {
    let signal: AbortSignal | null | undefined;
    const t = cli({
      ...f,
      http: async (_url, init) => {
        signal = init?.signal;
        return new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }),
        );
      },
    });
    try {
      const running = t.run(['add', 'docs', '-a', 'codex', '--registry', 'https://registry.test']);
      await vi.waitFor(() => expect(signal).toBeDefined());
      t.key('escape');
      expect(await running).toBe(0);
      expect(signal?.aborted).toBe(true);
      expect(t.rendered()).toContain('Отменено.');
      expect(t.rendered()).not.toContain('Область установки');
      expect(t.input.isRaw).toBe(false);
      expect(t.input.listenerCount('keypress')).toBe(0);
      await expect(access(join(f.roots.cwd, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      t.close();
    }
  });
});

it('scrolls remove through 35 packages in an 80×24 terminal', async () => {
  await withTestEnvironment(async (f) => {
    const store = new StateStore(getStatePaths(f.roots, 'project'));
    await store.write({
      version: 1,
      packages: Array.from({ length: 35 }, (_, i) => {
        const slug = `package-${String(i).padStart(2, '0')}`;
        return {
          slug,
          registryUrl: 'https://registry.test',
          version: '1.0.0',
          skills: [
            {
              name: 'check',
              installName: slug,
              archiveHash: 'a'.repeat(64),
              contentHash: 'b'.repeat(64),
              connections: [{ agent: 'codex', kind: 'direct', path: `.agents/skills/${slug}` }],
            },
          ],
        };
      }),
    });
    const t = cli(f);
    try {
      const pending = t.run(['remove', '-p']);
      await t.wait('Выберите пакет');
      for (let i = 0; i < 34; i++) t.key('down');
      await t.wait('package-34');
      expect(t.rendered()).not.toContain('Увеличьте окно терминала');
      t.key('return');
      await t.wait('Выберите скиллы для удаления');
      t.key('return');
      await t.wait('Выберите подключения для удаления');
      t.key('return');
      await t.wait('Удалить выбранные подключения пакета package-34?');
      t.key('y', 'y');
      expect(await pending).toBe(0);
      expect((await store.read())?.packages).toHaveLength(34);
      expect((await store.read())?.packages.some((p) => p.slug === 'package-34')).toBe(false);
    } finally {
      t.close();
    }
  });
});
