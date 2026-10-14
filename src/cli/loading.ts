import { S_BAR } from '@clack/prompts';
import { styleText } from 'node:util';
import type { PromptStreams } from './agents-prompt.ts';
import { truncateTerminalText } from './table.ts';

/**
 * Создаёт индикатор с задержкой 200 мс только для пары TTY-потоков; не захватывает ввод и не прерывает
 * процесс. Владелец вызывает stop перед диалогом/выводом, либо run для очистки в finally.
 *
 * @param render - Встраивает кадр в существующий экран (find); null удаляет индикатор. Такой экран сам
 * управляет курсором и шириной. Без callback индикатор занимает одну строку с запасом в колонку.
 */
export function createLoading(streams: PromptStreams, render?: (line: string | null) => void) {
  const frames = ['◒', '◐', '◓', '◑'];
  let pending: ReturnType<typeof setTimeout> | undefined;
  let animation: ReturnType<typeof setInterval> | undefined;
  let visible = false;

  /** Снимает оба таймера и очищает показанный кадр; повторный вызов не пишет в терминал. */
  const stop = () => {
    clearTimeout(pending);
    clearInterval(animation);
    pending = undefined;
    animation = undefined;
    if (!visible) return;
    visible = false;
    if (render) render(null);
    else streams.output.write('\r\u001b[2K\u001b[?25h');
  };

  /** Заменяет прежний этап; быстрые операции завершаются до первого кадра без вывода. */
  const start = (message: string) => {
    stop();
    if (!streams.input.isTTY || !streams.output.isTTY) return;
    pending = setTimeout(() => {
      pending = undefined;
      visible = true;
      let frame = 0;
      const draw = () => {
        const line = `${frames[frame++ % frames.length]} ${message}`;
        if (render) render(line);
        else
          streams.output.write(
            '\r\u001b[2K' +
              styleText(
                'cyan',
                truncateTerminalText(
                  `${S_BAR} ${line}`,
                  Math.max(0, (streams.output.columns ?? 80) - 1),
                ),
              ),
          );
      };
      if (!render) streams.output.write('\u001b[?25l');
      animation = setInterval(draw, 80);
      draw();
    }, 200);
  };

  /** Показывает этап ожидания и освобождает индикатор при успехе, ошибке или отмене операции. */
  const run = async <T>(message: string, operation: () => Promise<T>): Promise<T> => {
    start(message);
    try {
      return await operation();
    } finally {
      stop();
    }
  };
  return { start, stop, run };
}
