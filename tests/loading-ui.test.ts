import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'fast-string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAddUi } from '../src/cli/add-ui.ts';
import { selectRegistrySkill } from '../src/cli/find-ui.ts';
import { createProgram } from '../src/cli/program.ts';
import { Installer } from '../src/installer/installer.ts';
import { RegistryClient } from '../src/registry/client.ts';
import type { RuntimeContext } from '../src/runtime.ts';
import { withTestEnvironment } from './helpers/test-environment.ts';
import { versionRegistry } from './helpers/versions.ts';

function terminal(inputTTY = true, outputTTY = true, columns = 48) {
  let rendered = '';
  const input = Object.assign(new PassThrough(), {
    isTTY: inputTTY,
    isRaw: false,
    setRawMode(raw: boolean) {
      input.isRaw = raw;
    },
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
    close() {
      input.destroy();
      output.destroy();
    },
  };
}

const context: RuntimeContext = {
  roots: { cwd: '/private/tmp/loading-project', home: '/private/tmp/loading-home' },
  env: {},
  http: async () => {
    throw new Error('Unexpected HTTP');
  },
};

afterEach(() => vi.useRealTimers());

describe('loading during add preparation', () => {
  it('does not print an indicator after a fast operation has completed', async () => {
    vi.useFakeTimers();
    const t = terminal();
    try {
      expect(await createAddUi(context, t).run(async () => 'done')).toBe('done');
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.rendered()).toBe('');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      t.close();
    }
  });

  it('leaves fast operations silent and animates a slow operation after 200 ms', async () => {
    vi.useFakeTimers();
    const t = terminal();
    const ui = createAddUi(context, t, true);
    let finish!: () => void;
    const pending = ui.run(() => new Promise<void>((done) => (finish = done)));
    try {
      await vi.advanceTimersByTimeAsync(199);
      expect(t.rendered()).toBe('');
      await vi.advanceTimersByTimeAsync(1);
      expect(stripVTControlCharacters(t.rendered())).toContain('Подготовка скилла');
      const firstFrame = t.rendered();
      await vi.advanceTimersByTimeAsync(80);
      expect(t.rendered()).not.toBe(firstFrame);
      for (const line of stripVTControlCharacters(t.rendered()).split('\r'))
        expect(stringWidth(line)).toBeLessThan(t.output.columns);
      finish();
      await pending;
      const stopped = t.rendered();
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.rendered()).toBe(stopped);
      expect(t.rendered()).toContain('\u001b[?25h');
      expect(t.input.isRaw).toBe(false);
      expect(t.input.listenerCount('keypress')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish();
      await pending;
      t.close();
    }
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])('does not animate without both TTY streams (%j, %j)', async (inputTTY, outputTTY) => {
    vi.useFakeTimers();
    const t = terminal(inputTTY, outputTTY);
    let finish!: () => void;
    const pending = createAddUi(context, t).run(() => new Promise<void>((done) => (finish = done)));
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.rendered()).toBe('');
      expect(t.input.isRaw).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish();
      await pending;
      t.close();
    }
  });

  it('clears the indicator and input handlers when preparation fails', async () => {
    vi.useFakeTimers();
    const t = terminal();
    let fail!: (cause: Error) => void;
    const pending = createAddUi(context, t).run(
      () => new Promise<void>((_resolve, reject) => (fail = reject)),
    );
    const rejected = expect(pending).rejects.toThrow('Preparation failed');
    try {
      await vi.advanceTimersByTimeAsync(280);
      expect(t.rendered()).toContain('\u001b[?25l');
      fail(new Error('Preparation failed'));
      await rejected;
      expect(t.rendered()).toContain('\u001b[?25h');
      expect(t.input.isRaw).toBe(false);
      expect(t.input.listenerCount('keypress')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fail(new Error('Preparation failed'));
      await rejected;
      t.close();
    }
  });

  it('clears preparation before confirmation, stays quiet during the question and resumes after approval', async () => {
    vi.useFakeTimers();
    const t = terminal(true, true, 110);
    const ui = createAddUi(context, t);
    let prepared!: () => void, installed!: () => void;
    const preparation = new Promise<void>((done) => (prepared = done));
    const installation = new Promise<void>((done) => (installed = done));
    const pending = ui.run(async () => {
      await preparation;
      const decision = await ui.review({
        name: 'demo',
        version: null,
        description: 'Demo',
        source: { kind: 'directory', path: './demo' },
        scope: 'project',
        policy: 'local',
        sharedDirectory: '/private/tmp/loading-project/.agents/skills/demo',
        destinations: [],
      });
      if (decision === 'approve') await installation;
      return decision;
    });
    try {
      await vi.advanceTimersByTimeAsync(280);
      prepared();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.rendered()).toContain('Установить demo?');
      expect(t.rendered().indexOf('\u001b[?25h')).toBeLessThan(
        t.rendered().indexOf('Версия: локальный источник'),
      );
      const prompt = t.rendered();
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.rendered()).toBe(prompt);
      t.input.write('\u001b[C\r');
      await vi.advanceTimersByTimeAsync(280);
      expect(stripVTControlCharacters(t.rendered().slice(prompt.length))).toContain(
        'Установка скилла',
      );
      installed();
      expect(await pending).toBe('approve');
      expect(vi.getTimerCount()).toBe(0);
      expect(t.input.isRaw).toBe(false);
    } finally {
      prepared();
      installed();
      t.input.write('\u001b');
      await pending;
      t.close();
    }
  });
});

describe('loading in existing command screens', () => {
  it.each(['success', 'error'] as const)(
    'stops animating find after an HTTP %s and releases timers when closing',
    async (outcome) => {
      vi.useFakeTimers();
      const t = terminal();
      let finish!: (response: Response) => void;
      const client = new RegistryClient(
        'https://registry.example.test',
        async () => new Promise<Response>((done) => (finish = done)),
      );
      const pending = selectRegistrySkill(client, 'de', t);
      try {
        await vi.advanceTimersByTimeAsync(280);
        finish(
          outcome === 'success'
            ? Response.json({ items: [] })
            : new Response(null, { status: 503 }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(stripVTControlCharacters(t.rendered())).toContain(
          outcome === 'success' ? 'не найдены' : 'Не удалось выполнить поиск',
        );
        expect(vi.getTimerCount()).toBe(0);
        const ready = t.rendered();
        await vi.advanceTimersByTimeAsync(1000);
        expect(t.rendered()).toBe(ready);
      } finally {
        finish(Response.json({ items: [] }));
        t.input.emit('keypress', '\u001b', { name: 'escape' });
        await pending;
        t.close();
      }
    },
  );

  it('animates find in its own screen, ignores Enter while loading and cleans up on cancellation', async () => {
    vi.useFakeTimers();
    const t = terminal();
    let signal: AbortSignal | undefined;
    const client = new RegistryClient('https://registry.example.test', async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    });
    const pending = selectRegistrySkill(client, 'de', t);
    try {
      await vi.advanceTimersByTimeAsync(199);
      expect(t.rendered()).not.toContain('◒');
      await vi.advanceTimersByTimeAsync(1);
      expect(stripVTControlCharacters(t.rendered())).toContain('◒ Поиск в реестре');
      const frame = t.rendered();
      await vi.advanceTimersByTimeAsync(80);
      expect(t.rendered()).not.toBe(frame);
      t.input.emit('keypress', '\r', { name: 'return' });
      expect(signal!.aborted).toBe(false);
      t.input.emit('keypress', '\u001b', { name: 'escape' });
      expect(await pending).toBeNull();
      expect(signal!.aborted).toBe(true);
      expect(t.input.isRaw).toBe(false);
      expect(t.input.listenerCount('keypress')).toBe(0);
      expect(t.output.listenerCount('resize')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      const closed = t.rendered();
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.rendered()).toBe(closed);
    } finally {
      t.input.emit('keypress', '\u001b', { name: 'escape' });
      await pending;
      t.close();
    }
  });

  it('shows a delayed update check and clears it before the result table', async () => {
    const backend = versionRegistry();
    await withTestEnvironment(async (f) => {
      await new Installer({ ...f, http: backend.http }, { registry: backend.url }).add('demo');
      let started!: () => void, release!: () => void;
      const waiting = new Promise<void>((done) => (started = done));
      const gate = new Promise<void>((done) => (release = done));
      const t = terminal(true, true, 110);
      vi.useFakeTimers();
      const pending = createProgram(
        '0.1.0',
        {
          ...f,
          http: async (url, init) => {
            started();
            await gate;
            return backend.http(url, init);
          },
        },
        { write: (message) => t.output.write(`${message}\n`) },
        t,
      ).parseAsync(['update'], { from: 'user' });
      try {
        await waiting;
        await vi.advanceTimersByTimeAsync(280);
        expect(stripVTControlCharacters(t.rendered())).toContain('Проверка обновлений');
        release();
        await pending;
        expect(t.rendered().lastIndexOf('\u001b[?25h')).toBeLessThan(
          t.rendered().lastIndexOf('Обновлений нет.'),
        );
        expect(vi.getTimerCount()).toBe(0);
        const completed = t.rendered();
        await vi.advanceTimersByTimeAsync(1000);
        expect(t.rendered()).toBe(completed);
      } finally {
        release();
        await pending;
        t.close();
        vi.useRealTimers();
      }
    });
  });
});
