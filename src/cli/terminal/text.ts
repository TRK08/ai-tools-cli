import stringWidth from 'fast-string-width';

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

/** Заменяет управляющие и форматирующие символы данных пробелами для безопасного вывода в терминал. */
export function terminalText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
}

/** Показывает участок запроса вокруг курсора, сохраняя целые графемы и полный исходный запрос. */
export function queryViewport(before: string, after: string, width: number): string {
  const segments = [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(before),
  ].map((item) => item.segment);
  let tail = '';
  while (segments.length && stringWidth(segments.at(-1)! + tail) <= width - 2) {
    tail = segments.pop()! + tail;
  }
  const prefix = (segments.length ? '…' : '') + tail + '█';
  return prefix + truncateTerminalText(after, width - stringWidth(prefix));
}
