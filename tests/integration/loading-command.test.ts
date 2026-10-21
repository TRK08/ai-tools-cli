import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

import { afterEach, expect, it, vi } from 'vitest';

import { createProgram } from '../../src/cli/program.ts';
import { Installer } from '../../src/installer/installer.ts';

import { withTestEnvironment } from '../helpers/test-environment.ts';
import { versionRegistry } from '../helpers/versions.ts';

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
