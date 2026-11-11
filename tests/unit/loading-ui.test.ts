import { RegistryFindSearch } from '@/cli/find-search';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'fast-string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAddPreparation } from '@/cli/ui/add-ui';
import { selectRegistrySkill } from '@/cli/ui/find-ui';

import { RegistryClient } from '@/registry/client';

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

afterEach(() => vi.useRealTimers());

describe('loading during add preparation', () => {
  it('does not print an indicator after a fast operation has completed', async () => {
    vi.useFakeTimers();
    const t = terminal();
    try {
      expect(await runAddPreparation(t, 'Подготовка скилла', async () => 'done')).toBe('done');
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
    let finish!: () => void;
    const pending = runAddPreparation(
      t,
      'Подготовка скилла',
      () => new Promise<void>((done) => (finish = done)),
    );
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
    const pending = runAddPreparation(
      t,
      'Подготовка скилла',
      () => new Promise<void>((done) => (finish = done)),
    );
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
    const pending = runAddPreparation(
      t,
      'Подготовка скилла',
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

  it('clears the indicator before handing input to the next dialog', async () => {
    vi.useFakeTimers();
    const t = terminal();
    let proceed!: () => void;
    const ready = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const pending = runAddPreparation(t, 'Подготовка', async (_signal, stop) => {
      await ready;
      stop();
      expect(t.input.isRaw).toBe(false);
      expect(t.input.listenerCount('keypress')).toBe(0);
      t.output.write('Сводка');
    });
    try {
      await vi.advanceTimersByTimeAsync(280);
      proceed();
      await pending;
      expect(t.rendered().indexOf('\u001b[?25h')).toBeLessThan(t.rendered().indexOf('Сводка'));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      proceed();
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
      const pending = selectRegistrySkill(
        (changed) => new RegistryFindSearch(client, changed),
        'dem',
        t,
      );
      try {
        await vi.advanceTimersByTimeAsync(280);
        finish(
          outcome === 'success'
            ? Response.json({ items: [], total: 0, limit: 10, offset: 0 })
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
        finish(Response.json({ items: [], total: 0, limit: 10, offset: 0 }));
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
    const pending = selectRegistrySkill(
      (changed) => new RegistryFindSearch(client, changed),
      'dem',
      t,
    );
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
});
