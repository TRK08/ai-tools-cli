import { describe, expect, it } from 'vitest';
import { truncateTerminalText } from '../src/cli/table.ts';

describe('terminal truncation', () => {
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
