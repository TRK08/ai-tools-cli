import stringWidth from 'fast-string-width';
import type { Writable } from 'node:stream';

interface TableColumn {
  readonly title: string;
  readonly maximum: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Сокращает подпись до экранной ширины с многоточием, сохраняя целые графемы. */
export function truncateTerminalText(value: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(value) <= width) return value;
  let result = '';
  for (const { segment } of segmenter.segment(value)) {
    if (stringWidth(result + segment) > width - 1) break;
    result += segment;
  }
  return result + '…';
}

/**
 * Переносит текст по экранной ширине, сохраняя графемы и исходные разрывы строк. Предпочитает границы
 * пути или пробела; сохраняет разделители и пробелы, в том числе внутри файловых путей.
 */
export function wrapTerminalText(value: string, width: number): string[] {
  return value.split('\n').flatMap((line) => {
    const lines: string[] = [];
    let current = '';
    for (const { segment } of segmenter.segment(line)) {
      while (current && stringWidth(current + segment) > width) {
        const space = current.lastIndexOf(' ');
        const slash = Math.max(current.lastIndexOf('/'), current.lastIndexOf('\\'));
        const split = slash > 0 ? slash + 1 : space > 0 ? space + 1 : current.length;
        lines.push(current.slice(0, split));
        current = current.slice(split);
      }
      current += segment;
    }
    lines.push(current);
    return lines;
  });
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
