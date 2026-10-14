import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/cli/program.ts';
import { Installer } from '../src/installer/installer.ts';
import { hashDirectory } from '../src/state/hash.ts';
import { getStatePaths } from '../src/state/paths.ts';
import { catalogItem, skillDetail } from './helpers/discovery.ts';
import { runCli } from './helpers/cli.ts';
import { archiveBytes, skillText } from './helpers/archive.ts';
import { withTestEnvironment, type TestEnvironment } from './helpers/test-environment.ts';
import { versionRegistry } from './helpers/versions.ts';
import { directorySourceFileSystem } from '../src/sources/filesystem.ts';

function terminal(tty = true, columns = 160) {
  let rendered = '';
  const input = Object.assign(new PassThrough(), {
    isTTY: tty,
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
    { isTTY: tty, columns, rows: 40 },
  );
  return {
    input,
    output,
    rendered: () => rendered,
    close() {
      input.destroy();
      output.destroy();
    },
  };
}
const enter = '\r',
  down = '\u001b[B';
const wait = (t: ReturnType<typeof terminal>, text: string) =>
  vi.waitFor(() => expect(t.rendered()).toContain(text), { interval: 5 });
async function key(t: ReturnType<typeof terminal>, value: string) {
  t.input.write(value);
  await new Promise<void>((done) => setImmediate(done));
}
const run = (f: TestEnvironment, t: ReturnType<typeof terminal>, args: string[]) =>
  createProgram('0.1.0', f, { write: (value) => t.output.write(`${value}\n`) }, t).parseAsync(
    args,
    { from: 'user' },
  );
async function source(f: TestEnvironment, archive = false) {
  const path = join(f.roots.cwd, archive ? 'demo.tgz' : 'demo');
  if (archive) await writeFile(path, archiveBytes([{ path: 'SKILL.md', contents: skillText }]));
  else {
    await mkdir(path);
    await writeFile(join(path, 'SKILL.md'), skillText);
  }
  return path;
}

describe('scope, agents and installation card', () => {
  it.each([
    ['project', '\u001b'],
    ['global', '\u0003'],
  ] as const)(
    'cancels %s local preparation with %j after closing the in-flight operation',
    async (scope, cancelKey) =>
      withTestEnvironment(async (f) => {
        const path = await source(f);
        await writeFile(join(path, 'large'), Buffer.alloc(200_000, 0x61));
        const before = await hashDirectory(f.temporaryRoot);
        const t = terminal();
        let start!: () => void, resume!: () => void;
        const started = new Promise<void>((done) => {
            start = done;
          }),
          release = new Promise<void>((done) => {
            resume = done;
          });
        const open = directorySourceFileSystem.open;
        vi.spyOn(directorySourceFileSystem, 'open').mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (String(args[0]).endsWith('/large') && args[1] !== 'wx') {
            start();
            await release;
          }
          return handle;
        });
        const paths = getStatePaths(f.roots, scope);
        let settled = false;
        const pending = run(f, t, [
          'add',
          path,
          '-a',
          'codex',
          ...(scope === 'global' ? ['-g'] : []),
        ]);
        pending
          .finally(() => {
            settled = true;
          })
          .catch(() => {});
        try {
          if (scope === 'project') {
            await wait(t, 'Область установки');
            await key(t, enter);
          }
          await started;
          const cancelled = new Promise<void>((done) => t.input.once('keypress', () => done()));
          await key(t, cancelKey);
          await cancelled;
          expect(settled).toBe(false);
          expect((await lstat(paths.operationLockPath)).isFile()).toBe(true);
          resume();
          await pending;
          expect(t.rendered()).toContain('Отменено.');
          expect(t.rendered()).not.toContain('Установить demo?');
          expect(t.input.isRaw).toBe(false);
          await expect(lstat(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await hashDirectory(f.temporaryRoot)).toBe(before);
          expect((await new Installer(f, { scope }).add(path, false, ['codex'])).status).toBe(
            'success',
          );
        } finally {
          resume();
          await pending.catch(() => {});
          t.close();
        }
      }),
  );
  it('takes a find selection through scope and latest-policy card, then declines without events', async () =>
    withTestEnvironment(async (f) => {
      const backend = versionRegistry();
      const http = vi.fn<typeof fetch>(async (input, init) => {
        if (new URL(String(input)).pathname === '/origin/api/v1/skills')
          return Response.json({ items: [catalogItem({ currentVersion: '1.0.0' })] });
        return backend.http(input, init);
      });
      const context = { ...f, http, env: { ...f.env, DISABLE_TELEMETRY: '', DO_NOT_TRACK: '' } };
      const before = await hashDirectory(f.temporaryRoot);
      const t = terminal();
      try {
        const pending = run(context, t, ['find', 'de', '-a', 'codex', '--registry', backend.url]);
        await wait(t, 'demo@1.0.0');
        expect(t.rendered()).not.toContain('Поиск скиллов · project');
        expect(backend.requests).toEqual([]);
        await key(t, enter);
        await wait(t, 'Область установки');
        await key(t, down);
        await key(t, enter);
        await wait(t, 'Установить demo?');
        expect(t.rendered()).not.toContain('Обновление:');
        expect(t.rendered()).toContain(join(f.roots.home, '.agents/skills/demo'));
        expect(t.rendered()).not.toContain('Выберите агентов');
        await key(t, enter);
        await pending;
        expect(backend.requests).toEqual([
          `${backend.url}/api/v1/skills/demo/artifact?version=1.0.0`,
          `${backend.url}/api/v1/skills/demo?version=1.0.0`,
        ]);
        expect(http.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
        expect(await hashDirectory(f.temporaryRoot)).toBe(before);
      } finally {
        t.close();
      }
    }));

  it.each(['project', 'global'] as const)(
    'asks in order and installs into the selected %s scope',
    async (scope) =>
      withTestEnvironment(async (f) => {
        const local = await source(f);
        const t = terminal();
        try {
          const pending = run(f, t, ['add', local]);
          await wait(t, 'Область установки');
          expect(t.rendered()).not.toContain('Выберите агентов');
          if (scope === 'global') await key(t, down);
          await key(t, enter);
          await wait(
            t,
            `Выберите агентов (${scope === 'project' ? 'текущий проект' : 'глобальная область'})`,
          );
          expect(t.rendered()).not.toContain('Установка скилла');
          await key(t, enter);
          await wait(t, 'Установить demo?');
          const paths = getStatePaths(f.roots, scope);
          await expect(lstat(paths.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(t.rendered()).toContain('Версия: локальный источник');
          expect(t.rendered()).not.toContain('Обновление:');
          expect(t.rendered()).toContain(join(paths.skillsDirectory, 'demo'));
          expect(t.rendered()).toContain('OpenCode, Codex, Cursor, Pi');
          expect(t.rendered()).not.toContain('│ Claude Code ');
          await key(t, '\u001b[C\r');
          await pending;
          expect((await new Installer(f, { scope }).list())[0]!.agents).toEqual([
            'codex',
            'cursor',
            'opencode',
            'pi',
          ]);
          expect(t.input.isRaw).toBe(false);
        } finally {
          t.close();
        }
      }),
  );

  it('shows the selected registry version and short description without long text, then retains latest policy', async () =>
    withTestEnvironment(async (f) => {
      const backend = versionRegistry();
      const http = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/origin/api/v1/skills/demo') {
          expect(url.searchParams.get('version')).toBe('1.0.0');
          return Response.json(
            skillDetail({
              currentVersion: '2.0.0',
              version: '1.0.0',
              versions: ['2.0.0', '1.0.0'],
              shortDescription: 'Краткое описание — Кириллица 🚀.\u001b[31m',
              longDescription: 'Paragraph one.\n\nКириллица 🚀 paragraph two.\u001b[31m',
            }),
          );
        }
        return backend.http(input, init);
      });
      const context = { ...f, http };
      const t = terminal(true, 74);
      try {
        const pending = run(context, t, [
          'add',
          'demo',
          '-g',
          '-a',
          'pi',
          '--registry',
          backend.url,
        ]);
        await wait(t, 'Установить demo?');
        expect(t.rendered()).not.toContain('Область установки');
        expect(t.rendered()).not.toContain('Выберите агентов');
        expect(t.rendered()).toContain('API Contract Checker');
        expect(t.rendered()).toContain('Версия: 1.0.0');
        expect(t.rendered()).toContain('Краткое описание — Кириллица 🚀.');
        expect(t.rendered()).not.toContain('Paragraph one.');
        expect(t.rendered()).not.toContain('paragraph two.');
        expect(t.rendered()).not.toContain('\u001b[31m');
        expect(t.rendered()).toContain('Установок: 2');
        expect(t.rendered()).toContain('Go, backend');
        expect(t.rendered()).toContain('Pi');
        expect(t.rendered()).not.toContain('Claude Code');
        expect(backend.requests).toEqual([`${backend.url}/api/v1/skills/demo/artifact`]);
        backend.current.demo = '3.0.0';
        await key(t, '\u001b[C\r');
        await pending;
        const record = (await new Installer(context, { scope: 'global' }).list())[0]!;
        expect(record).toMatchObject({ version: '1.0.0', policy: 'latest', agents: ['pi'] });
        expect(backend.requests).toContain(`${backend.url}/download/demo/1.0.0`);
      } finally {
        t.close();
      }
    }));

  it.each([enter, '\u001b', '\u0003'])(
    'declines/cancels local archive confirmation with %j and cleans temporary data',
    async (value) =>
      withTestEnvironment(async (f) => {
        const local = await source(f, true);
        const before = await hashDirectory(f.temporaryRoot);
        const t = terminal();
        try {
          const pending = run(f, t, ['add', local, '-g', '-a', 'codex', '--force']);
          await wait(t, 'Установить demo?');
          await key(t, value);
          await pending;
          expect(t.rendered()).toContain(value === enter ? 'Установка отклонена.' : 'Отменено.');
          expect(await hashDirectory(f.temporaryRoot)).toBe(before);
          expect(t.input.isRaw).toBe(false);
        } finally {
          t.close();
        }
      }),
  );

  it.each(['artifact', 'details'] as const)(
    'cancels %s loading without downloads, writes or events',
    async (stage) =>
      withTestEnvironment(async (f) => {
        const backend = versionRegistry();
        let signal: AbortSignal | null | undefined;
        const http = vi.fn<typeof fetch>(async (input, init) => {
          const url = String(input);
          if (stage === 'artifact' || new URL(url).pathname === '/origin/api/v1/skills/demo') {
            signal = init?.signal;
            return new Promise<Response>((_resolve, reject) =>
              signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
            );
          }
          return backend.http(input, init);
        });
        const context = { ...f, http, env: { ...f.env, DISABLE_TELEMETRY: '', DO_NOT_TRACK: '' } };
        const before = await hashDirectory(f.temporaryRoot);
        const t = terminal();
        try {
          const pending = run(context, t, [
            'add',
            'demo',
            '-g',
            '-a',
            'codex',
            '--registry',
            backend.url,
          ]);
          await vi.waitFor(() => expect(signal).toBeDefined(), { interval: 5 });
          await vi.waitFor(() => expect(t.rendered()).toContain('◒'), { interval: 5 });
          await key(t, '\u0003');
          await pending;
          expect(signal!.aborted).toBe(true);
          expect(t.rendered()).toContain('Отменено.');
          expect(http.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
          expect(await hashDirectory(f.temporaryRoot)).toBe(before);
          expect(t.input.isRaw).toBe(false);
          expect(t.input.listenerCount('keypress')).toBe(0);
          expect(t.rendered()).toContain('\u001b[?25h');
        } finally {
          t.close();
        }
      }),
  );

  it.each(['version mismatch', 'HTTP error'] as const)(
    'rejects card %s before downloading',
    async (failure) =>
      withTestEnvironment(async (f) => {
        const backend = versionRegistry();
        const http = vi.fn<typeof fetch>(async (input, init) =>
          new URL(String(input)).pathname === '/origin/api/v1/skills/demo'
            ? failure === 'HTTP error'
              ? new Response(null, { status: 503 })
              : Response.json(skillDetail())
            : backend.http(input, init),
        );
        const t = terminal();
        try {
          await expect(
            run({ ...f, http }, t, [
              'add',
              'demo',
              '-g',
              '-a',
              'codex',
              '--yes',
              '--registry',
              backend.url,
            ]),
          ).rejects.toThrow();
          expect(backend.requests).toEqual([`${backend.url}/api/v1/skills/demo/artifact`]);
          expect(t.rendered()).not.toContain('Установить demo?');
          await expect(lstat(getStatePaths(f.roots, 'global').lockPath)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        } finally {
          t.close();
        }
      }),
  );

  it('requires --yes without TTY before reading source and shows the card when explicitly approved', async () =>
    withTestEnvironment(async (f) => {
      const local = await source(f);
      const before = await hashDirectory(f.temporaryRoot);
      const denied = await runCli(f, ['add', local, '-a', 'codex']);
      expect(denied).toMatchObject({ status: 1, stdout: '' });
      expect(denied.stderr).toContain('используйте --yes');
      expect(await hashDirectory(f.temporaryRoot)).toBe(before);
      const installed = await runCli(f, ['add', local, '-a', 'codex', '--yes']);
      expect(installed).toMatchObject({ status: 0, stderr: '' });
      expect(installed.stdout).toContain('Установка скилла');
      expect(installed.stdout).toContain('Установлен demo');
      expect(installed.stdout).not.toContain('Установить demo?');
      expect(installed.stdout).not.toContain('Область установки');
      const paths = getStatePaths(f.roots, 'project');
      expect(JSON.parse(await readFile(paths.lockPath, 'utf8')).skills.demo.policy).toBe('local');
    }));
});
