import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAddUi, selectScope } from '../../src/cli/add-ui.ts';
import { selectRegistrySkill } from '../../src/cli/find-ui.ts';
import { multiselect } from '../../src/cli/terminal/multiselect.ts';
import { confirmAdd } from '../../src/cli/add-confirm.ts';
import { confirm } from '../../src/cli/terminal/select.ts';
import { RegistryClient } from '../../src/registry/client.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

function terminal(flowing = false, raw = false) {
  let rendered = '';
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: raw,
    setRawMode: vi.fn((value: boolean) => {
      input.isRaw = value;
    }),
  });
  if (flowing) input.resume();
  else input.pause();
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        rendered += chunk;
        done();
      },
    }),
    { isTTY: true, columns: 80, rows: 30 },
  );
  return { input, output, rendered: () => rendered };
}

function released(t: ReturnType<typeof terminal>, flowing = false, raw = false) {
  expect(t.input.isRaw).toBe(raw);
  expect(t.input.readableFlowing).toBe(flowing);
  for (const event of ['keypress', 'end', 'close', 'error'])
    expect(t.input.listenerCount(event)).toBe(0);
  for (const event of ['resize', 'finish', 'close', 'error'])
    expect(t.output.listenerCount(event)).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

afterEach(() => vi.useRealTimers());

describe.each(['find', 'agents', 'confirm', 'scope', 'plain-confirm', 'multiselect'] as const)(
  '%s terminal resource ownership',
  (kind) => {
    function run(t: ReturnType<typeof terminal>, observed?: (signal: AbortSignal) => void) {
      if (kind === 'plain-confirm')
        return confirm({ ...t, message: 'Продолжить?', active: 'Да', inactive: 'Нет' });
      if (kind === 'multiselect')
        return multiselect({
          ...t,
          message: 'Выберите',
          options: [{ value: 'one', label: 'Один' }],
          required: true,
        });
      if (kind === 'scope')
        return selectScope(
          false,
          { roots: { cwd: '/fixture', home: '/fixture-home' }, env: {}, http: fetch },
          t,
        );
      if (kind === 'agents')
        return multiselect({
          ...t,
          message: 'Агенты',
          context: ['Общая папка: /fixture'],
          search: true,
          locked: [],
          options: [{ value: 'one', label: 'Один' }],
        });
      if (kind === 'confirm') return confirmAdd('demo', t, new AbortController().signal);
      return selectRegistrySkill(
        new RegistryClient('https://example.test', async (_url, init) => {
          const signal = init!.signal as AbortSignal;
          observed?.(signal);
          return new Promise<Response>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          );
        }),
        'de',
        t,
      );
    }

    it.each(['input:close'] as const)(
      'cleans up on %s and ignores double finish',
      async (event) => {
        vi.useFakeTimers();
        const t = terminal(true, true);
        let signal: AbortSignal | undefined;
        const pending = run(t, (value) => {
          signal = value;
        });
        await vi.advanceTimersByTimeAsync(280);
        const [side, name] = event.split(':') as ['input' | 'output', string];
        t[side].emit(name);
        t.input.emit('keypress', '', { name: 'escape' });
        await pending;
        if (kind === 'find') expect(signal?.aborted).toBe(true);
        released(t, true, true);
        const final = t.rendered();
        await vi.advanceTimersByTimeAsync(1000);
        expect(t.rendered()).toBe(final);
        t.input.destroy();
        t.output.destroy();
      },
    );

    it.each(['output'] as const)(
      'preserves a %s error through a failing raw cleanup',
      async (side) => {
        vi.useFakeTimers();
        const t = terminal();
        const failure = new Error('stream failure');
        const pending = run(t);
        const rejected = expect(pending).rejects.toBe(failure);
        t.input.setRawMode.mockImplementationOnce(() => {
          throw new Error('cleanup failure');
        });
        t[side].emit('error', failure);
        await rejected;
        expect(t.input.listenerCount('keypress')).toBe(0);
        expect(t.output.listenerCount('resize')).toBe(0);
        expect(t.input.readableFlowing).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        t.input.destroy();
        t.output.destroy();
      },
    );

    it('handles an asynchronous Writable error without leaving an unhandled stream error', async () => {
      vi.useFakeTimers();
      const t = terminal();
      const failure = new Error('async write failed');
      const output = Object.assign(
        new Writable({
          write(_chunk, _encoding, done) {
            done(failure);
          },
        }),
        { isTTY: true, columns: 80, rows: 30 },
      );
      await expect(run({ ...t, output })).rejects.toBe(failure);
      expect(t.input.listenerCount('keypress')).toBe(0);
      expect(output.listenerCount('error')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      t.input.destroy();
      t.output.destroy();
      output.destroy();
    });

    it.each(['render'] as readonly ('raw' | 'resume' | 'render')[])(
      'cleans a partial %s setup and preserves foreign listeners',
      async (stage) => {
        vi.useFakeTimers();
        const t = terminal();
        const failure = new Error('setup failure');
        const foreign = vi.fn();
        t.input.on('keypress', foreign);
        if (stage === 'raw')
          t.input.setRawMode.mockImplementationOnce(() => {
            throw failure;
          });
        if (stage === 'resume')
          vi.spyOn(t.input, 'resume').mockImplementationOnce(() => {
            throw failure;
          });
        if (stage === 'render')
          vi.spyOn(t.output, 'write').mockImplementationOnce(() => {
            throw failure;
          });
        await expect(run(t)).rejects.toBe(failure);
        expect(t.input.listeners('keypress')).toEqual([foreign]);
        t.input.off('keypress', foreign);
        released(t);
        t.input.destroy();
        t.output.destroy();
      },
    );
  },
);

describe('add preparation and confirmation lifecycle', () => {
  it.each([
    'input:end',
    'input:close',
    'output:finish',
    'output:close',
    'input:error',
    'output:error',
    'escape',
    'ctrl-c',
  ] as const)('waits for operation cleanup after %s, then releases resources', async (event) => {
    vi.useFakeTimers();
    await withTestEnvironment(async (f) => {
      const t = terminal(true, true);
      const ui = createAddUi(f, t);
      let cleaned = false,
        settle!: () => void;
      const cleanup = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const pending = ui.run(async () => {
        await new Promise<void>((resolve) =>
          ui.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        await cleanup;
        cleaned = true;
        return 'cancelled';
      });
      const failure = new Error('broken stream');
      const expectation = event.endsWith('error')
        ? expect(pending).rejects.toBe(failure)
        : expect(pending).resolves.toBe('cancelled');
      await vi.advanceTimersByTimeAsync(280);
      if (event.includes(':')) {
        const [side, name] = event.split(':') as ['input' | 'output', string];
        t[side].emit(name, failure);
      } else
        t.input.emit(
          'keypress',
          '',
          event === 'escape' ? { name: 'escape' } : { name: 'c', ctrl: true },
        );
      expect(ui.signal.aborted).toBe(true);
      expect(cleaned).toBe(false);
      settle();
      await expectation;
      expect(cleaned).toBe(true);
      released(t, true, true);
      t.input.destroy();
      t.output.destroy();
    });
  });

  it.each(['raw', 'resume', 'spinner'] as const)(
    'cleans a failed %s setup/render',
    async (stage) => {
      vi.useFakeTimers();
      await withTestEnvironment(async (f) => {
        const t = terminal();
        const failure = new Error('render/setup failed');
        const ui = createAddUi(f, t);
        if (stage === 'raw')
          t.input.setRawMode.mockImplementationOnce(() => {
            throw failure;
          });
        if (stage === 'resume')
          vi.spyOn(t.input, 'resume').mockImplementationOnce(() => {
            throw failure;
          });
        const pending = ui.run(
          async () =>
            new Promise<void>((resolve) =>
              ui.signal.addEventListener('abort', () => resolve(), { once: true }),
            ),
        );
        const rejected = expect(pending).rejects.toBe(failure);
        if (stage === 'spinner') {
          vi.spyOn(t.output, 'write').mockImplementationOnce(() => {
            throw failure;
          });
          await vi.advanceTimersByTimeAsync(280);
        }
        await rejected;
        released(t);
        t.input.destroy();
        t.output.destroy();
      });
    },
  );

  it('does not cancel a transaction after approval and retains the output failure', async () => {
    vi.useFakeTimers();
    await withTestEnvironment(async (f) => {
      const t = terminal();
      const ui = createAddUi(f, t, true);
      let commit!: () => void,
        committed = false;
      const pending = ui.run(async () => {
        expect(
          await ui.review({
            name: 'demo',
            version: null,
            description: null,
            source: { kind: 'directory', path: './demo' },
            scope: 'project',
            policy: 'local',
            sharedDirectory: '/fixture/shared',
            destinations: [],
          }),
        ).toBe('approve');
        await new Promise<void>((resolve) => {
          commit = resolve;
        });
        committed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      const failure = new Error('output failed after approval');
      const rejected = expect(pending).rejects.toBe(failure);
      t.output.emit('error', failure);
      expect(ui.signal.aborted).toBe(false);
      expect(committed).toBe(false);
      commit();
      await rejected;
      expect(committed).toBe(true);
      released(t);
      t.input.destroy();
      t.output.destroy();
    });
  });
});
