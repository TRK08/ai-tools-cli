import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { executeCli } from '../../src/cli/run.ts';
import { createProgram } from '../../src/cli/program.ts';
import { Installer } from '../../src/installer/installer.ts';
import { getStatePaths } from '../../src/state/paths.ts';
import { hashDirectory } from '../../src/state/hash.ts';
import { terminal } from '../helpers/terminal.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';
import { versionRegistry } from '../helpers/versions.ts';

it.each([
  [false, false],
  [true, false],
  [false, true],
])('keeps non-TTY update/remove confirmation in commands (%s/%s)', async (inputTTY, outputTTY) => {
  await withTestEnvironment(async (runtime) => {
    const source = join(runtime.roots.cwd, 'source');
    await mkdir(source);
    await writeFile(join(source, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n');
    const installer = new Installer(runtime);
    await installer.add(source);
    await writeFile(join(source, 'new'), 'Changed');
    const out = terminal(inputTTY, outputTTY),
      err = terminal(false, false);
    const context = {
      runtime,
      version: 'test',
      stdin: out.input,
      stdout: out.output,
      stderr: err.output,
    };
    try {
      const before = await hashDirectory(runtime.temporaryRoot);
      expect(await executeCli(context, ['update'])).toBe(1);
      expect(out.rendered()).toContain('Доступно обновление');
      expect(out.rendered()).toContain('используйте --yes');
      expect(err.rendered()).toContain('Не удалось обновить один или несколько скиллов');
      expect(await hashDirectory(runtime.temporaryRoot)).toBe(before);
      expect(await executeCli(context, ['update', '--yes'])).toBe(0);
      expect(out.rendered()).toContain('Обновлён');
      const updated = await hashDirectory(runtime.temporaryRoot);
      expect(await executeCli(context, ['remove', 'demo'])).toBe(1);
      expect(err.rendered()).toContain('используйте remove <name> --yes');
      expect(await hashDirectory(runtime.temporaryRoot)).toBe(updated);
      expect(await executeCli(context, ['remove', 'demo', '--yes'])).toBe(0);
      expect(await installer.list()).toEqual([]);
      expect(out.input.setRawMode).not.toHaveBeenCalled();
    } finally {
      out.close();
      err.close();
    }
  });
});

it('writes add messages and list results only to the supplied stdout', async () => {
  await withTestEnvironment(async (runtime) => {
    const source = join(runtime.roots.cwd, 'source');
    await mkdir(source);
    await writeFile(join(source, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n');
    const out = terminal(false, false),
      err = terminal(false, false);
    const context = {
      runtime,
      version: 'test',
      stdin: out.input,
      stdout: out.output,
      stderr: err.output,
    };
    try {
      expect(await executeCli(context, ['add', source, '-a', 'codex', '--yes'])).toBe(0);
      expect(out.rendered()).toContain('Установлен demo (codex).');
      expect(await executeCli(context, ['list'])).toBe(0);
      expect(out.rendered()).toContain('Скиллов: 1');
      expect(err.rendered()).toBe('');
    } finally {
      out.close();
      err.close();
    }
  });
});

it.each(['card-error', 'stream-error'] as const)(
  'preserves %s during card loading without downloading',
  async (failure) => {
    await withTestEnvironment(async (fixture) => {
      const backend = versionRegistry(),
        out = terminal(),
        err = terminal(false, false);
      let signal: AbortSignal | null | undefined, rejectCard!: (cause: Error) => void;
      const http: typeof fetch = async (url, init) => {
        if (new URL(String(url)).pathname.endsWith('/skills/demo')) {
          if (failure === 'card-error') return new Response(null, { status: 503 });
          signal = init?.signal;
          return new Promise<Response>((_resolve, reject) => {
            rejectCard = reject;
          });
        }
        return backend.http(url, init);
      };
      const runtime = { ...fixture, http };
      const before = await hashDirectory(fixture.temporaryRoot);
      const streamError = new Error('primary output failure');
      let settled = false;
      const pending = createProgram({
        runtime,
        version: 'test',
        stdin: out.input,
        stdout: out.output,
        stderr: err.output,
      }).parseAsync(['add', 'demo', '-g', '-a', 'codex', '--yes', '--registry', backend.url], {
        from: 'user',
      });
      pending
        .finally(() => {
          settled = true;
        })
        .catch(() => {});
      const rejected =
        failure === 'stream-error'
          ? expect(pending).rejects.toBe(streamError)
          : expect(pending).rejects.toThrow('HTTP 503');
      try {
        if (failure === 'stream-error') {
          await vi.waitFor(() => expect(signal).toBeDefined());
          out.output.emit('error', streamError);
          expect(signal!.aborted).toBe(true);
          expect(settled).toBe(false);
          rejectCard(new Error('secondary HTTP abort'));
        }
        await rejected;
        expect(backend.requests).toEqual([`${backend.url}/api/v1/skills/demo/artifact`]);
        expect(out.rendered()).not.toContain('Установить demo?');
        expect(out.rendered()).not.toContain('Установка отклонена');
        expect(out.input.isRaw).toBe(false);
        expect(out.input.listenerCount('keypress')).toBe(0);
        expect(await hashDirectory(fixture.temporaryRoot)).toBe(before);
      } finally {
        out.close();
        err.close();
      }
    });
  },
);

it.each([
  { command: 'add', cardFails: false },
  { command: 'update', cardFails: false },
  { command: 'add', cardFails: true },
])(
  'waits for telemetry flush after $command, cardFails=$cardFails',
  async ({ command, cardFails }) => {
    await withTestEnvironment(async (fixture) => {
      const backend = versionRegistry();
      if (command === 'update') {
        await new Installer({ ...fixture, http: backend.http }, { registry: backend.url }).add(
          'demo',
        );
        backend.current.demo = '2.0.0';
      }
      let deliver!: () => void,
        deliveries = 0,
        settled = false;
      const gate = new Promise<void>((resolve) => {
        deliver = resolve;
      });
      const runtime = {
        ...fixture,
        env: { ...fixture.env, DISABLE_TELEMETRY: '', DO_NOT_TRACK: '' },
        http: (async (url, init) => {
          if (init?.method === 'POST') {
            deliveries++;
            await gate;
            return new Response(null, { status: 202 });
          }
          if (cardFails && new URL(String(url)).pathname.endsWith('/skills/demo'))
            return new Response(null, { status: 503 });
          return backend.http(url, init);
        }) as typeof fetch,
      };
      const out = terminal(false, false),
        err = terminal(false, false);
      const pending = createProgram({
        runtime,
        version: 'test',
        stdin: out.input,
        stdout: out.output,
        stderr: err.output,
      }).parseAsync(
        command === 'add'
          ? ['add', 'demo', '-a', 'codex', '--yes', '--registry', backend.url]
          : ['update', '--yes'],
        { from: 'user' },
      );
      pending
        .finally(() => {
          settled = true;
        })
        .catch(() => {});
      try {
        await vi.waitFor(() => expect(deliveries).toBeGreaterThan(0), { interval: 5 });
        // Installer уже освободил область: оставшееся ожидание принадлежит доставке событий.
        await vi.waitFor(
          async () => {
            await expect(
              lstat(getStatePaths(runtime.roots, 'project').operationLockPath),
            ).rejects.toMatchObject({ code: 'ENOENT' });
            if (!cardFails)
              expect((await new Installer(runtime).list())[0]?.version).toBe(
                command === 'update' ? '2.0.0' : '1.0.0',
              );
          },
          { interval: 5 },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        deliver();
        if (cardFails) await expect(pending).rejects.toThrow('HTTP 503');
        else await pending;
      } finally {
        deliver();
        await pending.catch(() => {});
        out.close();
        err.close();
      }
    });
  },
);
