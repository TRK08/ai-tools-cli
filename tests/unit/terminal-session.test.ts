import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { terminalSession } from '@/cli/terminal/session';

function fixture(raw = false, flowing = false) {
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
      write(_chunk, _encoding, done) {
        done();
      },
    }),
    { isTTY: true, columns: 80 },
  );
  return { input, output };
}
function released(t: ReturnType<typeof fixture>, raw = false, flowing = false) {
  expect(t.input.isRaw).toBe(raw);
  expect(t.input.readableFlowing).toBe(flowing);
  for (const event of ['keypress', 'end', 'close', 'error'])
    expect(t.input.listenerCount(event)).toBe(0);
  for (const event of ['finish', 'end', 'close', 'error', 'resize'])
    expect(t.output.listenerCount(event)).toBe(0);
}

describe('terminal session resource ownership', () => {
  it.each(['input:end', 'input:close', 'output:finish', 'output:end', 'output:close'] as const)(
    'routes %s and closes idempotently',
    (event) => {
      const t = fixture(true, true),
        end = vi.fn();
      const session = terminalSession(t, { key: vi.fn(), end, error: vi.fn(), resize: vi.fn() });
      session.start();
      session.start();
      const [side, name] = event.split(':') as ['input' | 'output', string];
      t[side].emit(name);
      expect(end).toHaveBeenCalledTimes(1);
      expect(session.close()).toBeUndefined();
      expect(session.close()).toBeUndefined();
      released(t, true, true);
      t.input.destroy();
      t.output.destroy();
    },
  );
  it.each(['input', 'output'] as const)(
    'preserves a %s error and still tries every cleanup step',
    (side) => {
      const t = fixture(),
        error = vi.fn(),
        failure = new Error('stream'),
        cleanup = new Error('raw cleanup');
      const session = terminalSession(t, { key: vi.fn(), end: vi.fn(), error });
      session.start();
      t[side].emit('error', failure);
      expect(error).toHaveBeenCalledExactlyOnceWith(failure);
      t.input.setRawMode.mockImplementationOnce(() => {
        throw cleanup;
      });
      expect(session.close()).toBe(cleanup);
      expect(t.input.readableFlowing).toBe(false);
      expect(t.input.listenerCount('keypress')).toBe(0);
      expect(t.output.listenerCount('error')).toBe(0);
      t.input.destroy();
      t.output.destroy();
    },
  );
  it.each(['raw', 'resume'] as const)(
    'cleans partially completed %s setup and preserves foreign handlers',
    (stage) => {
      const t = fixture(),
        foreign = vi.fn(),
        failure = new Error('setup');
      t.input.on('keypress', foreign);
      const session = terminalSession(t, {
        key: vi.fn(),
        end: vi.fn(),
        error: vi.fn(),
        resize: vi.fn(),
      });
      if (stage === 'raw')
        t.input.setRawMode.mockImplementationOnce(() => {
          throw failure;
        });
      else
        vi.spyOn(t.input, 'resume').mockImplementationOnce(() => {
          throw failure;
        });
      expect(() => session.start()).toThrow(failure);
      session.close();
      expect(t.input.listeners('keypress')).toEqual([foreign]);
      t.input.off('keypress', foreign);
      released(t);
      t.input.destroy();
      t.output.destroy();
    },
  );
  it('hands input to the next prompt while continuing to observe stream errors', () => {
    const t = fixture(),
      key = vi.fn(),
      error = vi.fn();
    const session = terminalSession(t, { key, end: vi.fn(), error });
    session.start();
    session.releaseInput();
    session.releaseInput();
    expect(t.input.listenerCount('keypress')).toBe(0);
    expect(t.input.isRaw).toBe(false);
    const failure = new Error('during commit');
    t.output.emit('error', failure);
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    session.close();
    released(t);
    t.input.destroy();
    t.output.destroy();
  });
});
