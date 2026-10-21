import stringWidth from 'fast-string-width';
import type { Writable } from 'node:stream';
import { wrapTerminalText } from './text.ts';

interface TableColumn {
  readonly title: string;
  readonly maximum: number;
}

/**
 * Пишет таблицу в переданный output, подбирая ширину колонок и перенося длинные значения. Выравнивание
 * учитывает экранную ширину Unicode, а не число кодовых единиц строки.
 */
export function renderTable(
  columns: readonly TableColumn[],
  rows: readonly (readonly string[])[],
  output: Writable & { readonly columns?: number },
): void {
  const widths = columns.map((column, index) => {
    const natural = rows.reduce(
      (maximum, row) =>
        Math.max(maximum, ...(row[index] ?? '').split('\n').map((line) => stringWidth(line))),
      stringWidth(column.title),
    );
    return Math.max(stringWidth(column.title), Math.min(column.maximum, natural));
  });
  const available = Math.max(
    columns.length * 3,
    (output.columns ?? 120) - (columns.length * 3 + 1),
  );
  while (widths.reduce((sum, width) => sum + width, 0) > available) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= 3) break;
    widths[widest]!--;
  }
  const border = (left: string, middle: string, right: string) =>
    left + widths.map((width) => '─'.repeat(width + 2)).join(middle) + right + '\n';
  const rowLines = (row: readonly string[]) => {
    const cells = columns.map((_, index) => wrapTerminalText(row[index] ?? '', widths[index]!));
    return Array.from(
      { length: Math.max(...cells.map((cell) => cell.length)) },
      (_, line) =>
        '│' +
        cells
          .map((cell, index) => {
            const text = cell[line] ?? '';
            return ` ${text}${' '.repeat(Math.max(0, widths[index]! - stringWidth(text)))} `;
          })
          .join('│') +
        '│\n',
    ).join('');
  };
  output.write(border('┌', '┬', '┐'));
  output.write(rowLines(columns.map((column) => column.title)));
  output.write(border('├', '┼', '┤'));
  rows.forEach((row, index) => {
    if (index) output.write(border('├', '┼', '┤'));
    output.write(rowLines(row));
  });
  output.write(border('└', '┴', '┘'));
}
