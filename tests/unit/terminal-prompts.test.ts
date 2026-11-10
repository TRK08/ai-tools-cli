import { afterEach, describe, expect, it, vi } from 'vitest';
import { select, confirm } from '@/cli/terminal/select';
import { confirmAdd } from '@/cli/ui/add-confirm';
import { multiselect } from '@/cli/terminal/multiselect';
import { terminal } from '../helpers/terminal.ts';

afterEach(() => vi.useRealTimers());

describe.each(['select', 'confirm', 'multiselect'] as const)(
  '%s restores its incoming terminal',
  (kind) => {
    it.each([
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ] as const)('restores raw=%s and flowing=%s on submit', async (raw, flowing) => {
      const t = terminal();
      t.input.isRaw = raw;
      if (flowing) t.input.resume();
      else t.input.pause();
      const options = {
        ...t,
        message: 'Выберите',
        options: [{ value: 'one', label: 'Один' }],
        initialValue: 'one',
      };
      const pending =
        kind === 'select'
          ? select(options)
          : kind === 'confirm'
            ? confirm({ ...t, message: 'Продолжить?', active: 'Да', inactive: 'Нет' })
            : multiselect({ ...options, initialValues: ['one'], required: true });
      try {
        t.input.write('\r');
        expect(await pending).toEqual(
          kind === 'select' ? 'one' : kind === 'confirm' ? false : ['one'],
        );
        expect([t.input.isRaw, t.input.readableFlowing]).toEqual([raw, flowing]);
        expect(t.input.listenerCount('keypress')).toBe(0);
        expect(t.output.listenerCount('resize')).toBe(0);
      } finally {
        t.close();
      }
    });
  },
);

describe('shared terminal choices', () => {
  it.each(['j', 'k', 'h', 'l'])('keeps confirm navigation alias %s', async (key) => {
    const t = terminal();
    const pending = confirm({ ...t, message: 'Продолжить?', active: 'Да', inactive: 'Нет' });
    try {
      t.input.write(key + '\r');
      expect(await pending).toBe(true);
    } finally {
      t.input.emit('keypress', '', { name: 'escape' });
      await pending;
      t.close();
    }
  });

  it.each([
    ['a\r', ['one', 'two']],
    ['aai\r', ['one', 'two']],
    [' i\r', ['two']],
    ['j \r', ['two']],
    ['k \r', ['two']],
    ['\u001b[A \r', ['two']],
  ] as const)('keeps plain multiselect shortcuts %j', async (keys, expected) => {
    const t = terminal();
    const pending = multiselect({
      ...t,
      message: 'Выберите',
      options: [
        { value: 'one', label: 'Один' },
        { value: 'two', label: 'Два' },
      ],
    });
    let completed = false;
    pending.then(() => {
      completed = true;
    });
    try {
      t.input.write(keys);
      await new Promise<void>((done) => setImmediate(done));
      expect(completed).toBe(true);
      expect(await pending).toEqual(expected);
    } finally {
      t.input.emit('keypress', '', { name: 'escape' });
      await pending;
      t.close();
    }
  });

  it('keeps add confirmation on Enter after the y shortcut', async () => {
    const t = terminal();
    let settled = false;
    const pending = confirmAdd('demo', t, new AbortController().signal).then((value) => {
      settled = true;
      return value;
    });
    try {
      t.input.write('y');
      await new Promise<void>((done) => setImmediate(done));
      expect(settled).toBe(false);
      t.input.write('\r');
      expect(await pending).toBe('approve');
    } finally {
      t.input.emit('keypress', '', { name: 'escape' });
      await pending;
      t.close();
    }
  });

  it.each(['y', 'Y', 'n', 'N'])('keeps immediate confirm shortcut %s', async (key) => {
    const t = terminal();
    let settled = false;
    const pending = confirm({ ...t, message: 'Продолжить?', active: 'Да', inactive: 'Нет' }).then(
      (value) => {
        settled = true;
        return value;
      },
    );
    try {
      t.input.write(key);
      await new Promise<void>((done) => setImmediate(done));
      expect(settled).toBe(true);
      expect(await pending).toBe(key.toLowerCase() === 'y');
    } finally {
      t.input.emit('keypress', '', { name: 'escape' });
      await pending;
      t.close();
    }
  });

  it('keeps the selected value through a tiny window and resumes after resize', async () => {
    const t = terminal(true, true, 40, 2);
    let settled = false;
    const pending = select({
      ...t,
      message: 'Выберите',
      initialValue: 'first',
      options: [
        { value: 'first', label: 'Первый' },
        { value: 'second', label: 'Второй' },
        { value: 'third', label: 'Третий' },
      ],
    }).then((value) => {
      settled = true;
      return value;
    });
    try {
      t.input.write('\u001b[B\r');
      await new Promise<void>((done) => setImmediate(done));
      expect(settled).toBe(false);
      expect(t.rendered()).toContain('Увеличьте окно терминала');
      t.output.rows = 12;
      t.output.emit('resize');
      t.input.write('\r');
      expect(await pending).toBe('second');
    } finally {
      t.input.emit('keypress', '', { name: 'escape' });
      await pending;
      t.close();
    }
  });

  it('distinguishes No from cancellation and unregisters an external AbortSignal', async () => {
    const t = terminal(),
      controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = confirm({
      ...t,
      message: 'Продолжить?',
      active: 'Да',
      inactive: 'Нет',
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toBeNull();
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(t.input.listenerCount('keypress')).toBe(0);
    t.close();
  });

  it('does not write a final frame or cursor to a finished output stream', async () => {
    const t = terminal(),
      errors: unknown[] = [];
    t.output.on('error', (cause) => errors.push(cause));
    const pending = confirm({ ...t, message: 'Продолжить?', active: 'Да', inactive: 'Нет' });
    t.output.end();
    expect(await pending).toBeNull();
    await new Promise<void>((done) => setImmediate(done));
    expect(errors).toEqual([]);
    expect(t.input.isRaw).toBe(false);
    t.close();
  });
});
