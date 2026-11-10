import { S_BAR } from '@clack/prompts';
import { styleText } from 'node:util';
import type { PromptStreams } from './types';
import { truncateTerminalText } from './text';
import { createScreen } from './screen';

/**
 * Создаёт индикатор с задержкой 200 мс только для пары TTY-потоков; не захватывает ввод и не прерывает
 * процесс. Владелец вызывает stop перед диалогом/выводом, либо run для очистки в finally.
 *
 * @param render - Встраивает кадр в существующий экран (find); null удаляет индикатор. Такой экран сам
 * управляет курсором и шириной. Без callback индикатор занимает одну строку с запасом в колонку.
 * @param onError - Передаёт ошибку отложенной отрисовки владельцу после снятия таймеров;
 * run без callback возвращает её после завершения операции, сохраняя исходную ошибку операции.
 */
export function createLoading(
  streams: PromptStreams,
  render?: (line: string | null) => void,
  onError?: (cause: unknown) => void,
) {
  const screen = createScreen(streams.output, true);
  const frames = ['◒', '◐', '◓', '◑'];
  let pending: ReturnType<typeof setTimeout> | undefined;
  let animation: ReturnType<typeof setInterval> | undefined;
  let visible = false;
  let failure: unknown;

  /** Снимает оба таймера и очищает показанный кадр; повторный вызов не пишет в терминал. */
  const stop = () => {
    clearTimeout(pending);
    clearInterval(animation);
    pending = undefined;
    animation = undefined;
    if (!visible) return;
    visible = false;
    if (render) render(null);
    else screen.close();
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
        try {
          const line = `${frames[frame++ % frames.length]} ${message}`;
          if (render) render(line);
          else
            screen.write([
              styleText(
                'cyan',
                truncateTerminalText(
                  `${S_BAR} ${line}`,
                  Math.max(0, (streams.output.columns ?? 80) - 1),
                ),
              ),
            ]);
        } catch (cause) {
          failure ??= cause;
          try {
            stop();
          } catch {
            /* Первичная ошибка отрисовки сохраняется. */
          }
          onError?.(cause);
        }
      };
      animation = setInterval(draw, 80);
      try {
        if (!render) screen.hideCursor();
      } catch (cause) {
        failure ??= cause;
        try {
          stop();
        } catch {
          /* Первичная ошибка отрисовки сохраняется. */
        }
        onError?.(cause);
        return;
      }
      draw();
    }, 200);
  };

  /** Показывает этап ожидания и освобождает индикатор при успехе, ошибке или отмене операции. */
  const run = async <T>(message: string, operation: () => Promise<T>): Promise<T> => {
    let error: unknown;
    let result!: T;
    try {
      start(message);
      result = await operation();
      if (failure !== undefined) throw failure;
    } catch (cause) {
      error = cause;
    }
    try {
      stop();
    } catch (cause) {
      error ??= cause;
    }
    if (error !== undefined) throw error;
    return result;
  };
  return { start, stop, run };
}
