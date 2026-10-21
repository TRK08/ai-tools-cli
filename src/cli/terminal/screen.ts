import { stripVTControlCharacters, styleText } from 'node:util';
import stringWidth from 'fast-string-width';
import type { PromptStreams, TerminalScreen } from './types.ts';
import { truncateTerminalText } from './text.ts';

/**
 * Владеет своим кадром и скрываемым курсором; ввод и события потоков остаются у session.
 * Считает физические строки исходного кадра по текущей ширине, в том числе после resize.
 * inline оставляет курсор на строке индикатора; обычный кадр завершается переводом строки.
 */
export function createScreen(output: PromptStreams['output'], inline = false): TerminalScreen {
  let previous: readonly string[] = [];
  let hidden = false;

  /** Стирает только предыдущий кадр; повторная очистка не пишет в терминал. */
  const clear = () => {
    if (!previous.length) return;
    const width = Math.max(1, output.columns ?? 80);
    const rows = previous.reduce(
      (sum, line) => sum + Math.max(1, Math.ceil(stringWidth(line) / width)),
      0,
    );
    previous = [];
    if (output.destroyed || output.writableEnded) return;
    output.write(
      inline
        ? `\r\u001b[2K${rows > 1 ? `\u001b[${rows - 1}A\r\u001b[J` : ''}`
        : `\u001b[${rows}A\r\u001b[J`,
    );
  };
  /** Заменяет кадр; размеры строк учитываются без ANSI, исходное оформление сохраняется. */
  const write = (lines: readonly string[]) => {
    clear();
    if (output.destroyed || output.writableEnded) return;
    previous = lines.map(stripVTControlCharacters);
    if (lines.length) output.write(lines.join('\n') + (inline ? '' : '\n'));
  };
  /** Скрывает курсор один раз; даже при ошибке записи очистка попробует его показать. */
  const hideCursor = () => {
    if (hidden) return;
    hidden = true;
    output.write('\u001b[?25l');
  };
  /** Освобождает принадлежащий экрану курсор, если выходной поток ещё доступен. */
  const showCursor = () => {
    if (!hidden) return;
    hidden = false;
    if (!output.destroyed && !output.writableEnded) output.write('\u001b[?25h');
  };
  /** Освобождает кадр и курсор, пробуя оба шага даже при ошибке очистки. */
  const close = (clearFrame = true) => {
    let error: unknown;
    try {
      if (clearFrame) clear();
    } catch (cause) {
      error = cause;
    }
    try {
      showCursor();
    } catch (cause) {
      error ??= cause;
    }
    if (error !== undefined) throw error;
  };
  return { clear, write, hideCursor, showCursor, close };
}

/** Собирает ограниченный размерами окна кадр; сокращение выполняется до добавления ANSI. */
export function createFrame(output: PromptStreams['output']) {
  const width = Math.max(0, (output.columns ?? 80) - 1);
  const height = Math.max(0, (output.rows ?? 24) - 1);
  const lines: string[] = [];
  const add = (
    text: string,
    format?: Parameters<typeof styleText>[0] | ((line: string) => string),
  ) => {
    const line = truncateTerminalText(text, width);
    lines.push(
      typeof format === 'function'
        ? format(line)
        : format
          ? styleText(format, line, { stream: output })
          : line,
    );
  };
  const section = (title: string) => {
    const prefix = `├─ ${title} `;
    add(prefix + '─'.repeat(Math.max(0, width - stringWidth(prefix))), ['bold', 'gray']);
  };
  return { width, height, lines, add, section };
}
