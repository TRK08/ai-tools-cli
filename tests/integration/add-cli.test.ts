import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '@/cli/program';
import { Installer } from '@/installer/installer';
import { hashDirectory } from '@/state/hash';
import { getStatePaths } from '@/state/paths';
import { catalogItem } from '../helpers/discovery.ts';

import { archiveBytes, skillText } from '../helpers/archive.ts';
import { withTestEnvironment, type TestEnvironment } from '../helpers/test-environment.ts';
import { versionRegistry } from '../helpers/versions.ts';
import { directorySourceFileSystem } from '@/sources/filesystem';

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
  createProgram({
    version: '0.1.0',
    runtime: f,
    stdin: t.input,
    stdout: t.output,
    stderr: t.output,
  }).parseAsync(args, { from: 'user' });
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
          if (basename(String(args[0])) === 'large' && args[1] !== 'wx') {
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
});
