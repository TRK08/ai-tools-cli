import { PassThrough, Writable } from 'node:stream';
import { vi } from 'vitest';

/** Управляемые TTY-потоки без настоящего терминала; caller закрывает их после завершения prompt. */
export function terminal(inputTTY = true, outputTTY = true, columns = 160, rows = 40) {
  let rendered = '';
  const input = Object.assign(new PassThrough(), {
    isTTY: inputTTY,
    isRaw: false,
    setRawMode: vi.fn((value: boolean) => {
      input.isRaw = value;
    }),
  });
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        rendered += String(chunk);
        done();
      },
    }),
    { isTTY: outputTTY, columns, rows },
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
