import { styleText } from 'node:util';
import type { PromptStreams } from './types';

/**
 * Выделяет цветом только значок выбора: активный текст обычный, остальные варианты серые.
 * Вызывающая сторона очищает данные и сокращает исходный текст либо переносит результат с учётом ANSI.
 * Стили не меняют экранную ширину строки.
 */
export function formatChoice(
  line: string,
  marker: string,
  active: boolean,
  selected: boolean,
  output: PromptStreams['output'],
): string {
  const text = (value: string) => (active ? value : styleText('gray', value, { stream: output }));
  const offset = line.indexOf(marker);
  if (offset < 0) return text(line);
  return (
    text(line.slice(0, offset)) +
    styleText(active ? 'cyan' : selected ? 'green' : 'gray', marker, { stream: output }) +
    text(line.slice(offset + marker.length))
  );
}
