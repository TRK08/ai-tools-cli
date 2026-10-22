import { emitKeypressEvents, type Key } from 'node:readline';
import type { PromptStreams } from './types';

/**
 * Владеет только своими обработчиками терминала. start может бросить ошибку setup;
 * вызывающий всё равно завершает сеанс через close. close идемпотентен, пробует все
 * шаги восстановления и возвращает первую ошибку очистки, сохраняя исходную у владельца.
 */
export function terminalSession(
  { input, output }: PromptStreams,
  handlers: {
    key: (value: string | undefined, key: Key) => void;
    end: () => void;
    error: (cause: unknown) => void;
    resize?: () => void;
  },
) {
  const previousRaw = input.isRaw ?? false;
  const wasFlowing = input.readableFlowing === true;
  let started = false;
  let closed = false;
  let released = false;

  /** Подключает EOF/close/error обоих потоков до raw mode; не трогает чужие listeners. */
  function start() {
    if (started || closed) return;
    started = true;
    input.on('keypress', handlers.key);
    input.on('end', handlers.end);
    input.on('close', handlers.end);
    input.on('error', handlers.error);
    output.on('finish', handlers.end);
    output.on('end', handlers.end);
    output.on('close', handlers.end);
    output.on('error', handlers.error);
    if (handlers.resize) output.on('resize', handlers.resize);
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();
  }

  /** Передаёт клавиатуру следующему диалогу, оставляя наблюдение за ошибками потоков. */
  function releaseInput(): unknown {
    if (!started || released) return;
    released = true;
    let error: unknown;
    const attempt = (operation: () => void) => {
      try {
        operation();
      } catch (cause) {
        error ??= cause;
      }
    };
    attempt(() => input.setRawMode?.(previousRaw));
    attempt(() => {
      if (wasFlowing) input.resume();
      else input.pause();
    });
    input.off('keypress', handlers.key);
    return error;
  }

  /** Снимает свои listeners и восстанавливает raw/flow даже после частичного setup. */
  function close(): unknown {
    if (closed) return;
    closed = true;
    const error = releaseInput();
    input.off('end', handlers.end);
    input.off('close', handlers.end);
    input.off('error', handlers.error);
    output.off('finish', handlers.end);
    output.off('end', handlers.end);
    output.off('close', handlers.end);
    output.off('error', handlers.error);
    if (handlers.resize) output.off('resize', handlers.resize);
    return error;
  }
  return { start, releaseInput, close };
}
