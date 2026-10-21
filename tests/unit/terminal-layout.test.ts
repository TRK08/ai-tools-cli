import { describe, expect, it } from 'vitest';
import { truncateTerminalText, wrapTerminalText } from '../../src/cli/terminal/text.ts';

describe('terminal truncation', () => {
  it('preserves spaces and graphemes while wrapping paths', () => {
    const path =
      'C:' +
      String.fromCharCode(92) +
      'Каталог с пробелами 👩‍💻' +
      String.fromCharCode(92) +
      'ресурс';
    expect(wrapTerminalText(path, 9).join('')).toBe(path);
  });
  it.each(['/', String.fromCharCode(92)])(
    'prefers path separator %j without changing path bytes',
    (separator) => {
      const path = ['C:', 'длинный', 'путь', 'ресурс'].join(separator);
      const lines = wrapTerminalText(path, 12);
      expect(lines.join('')).toBe(path);
      expect(lines[0]).toBe('C:' + separator + 'длинный' + separator);
    },
  );
  it.each([
    ['abc', 3, 'abc'],
    ['abcd', 3, 'ab…'],
    ['abcd', 1, '…'],
    ['abcd', 0, ''],
    ['界界ab', 4, '界…'],
    ['e\u0301e\u0301ab', 3, 'e\u0301e\u0301…'],
    ['👩‍💻abcd', 4, '👩‍💻a…'],
  ])('fits %j into %i display columns without splitting graphemes', (value, width, expected) => {
    expect(truncateTerminalText(value, width)).toBe(expected);
  });
});
