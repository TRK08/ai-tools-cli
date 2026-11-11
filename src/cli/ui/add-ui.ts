import { isCancellation } from '@/cancellation';
import { createLoading, terminalSession, type PromptStreams } from '@/cli/terminal';

/**
 * Показывает индикатор и владеет клавиатурой до stop. Esc/Ctrl+C отменяют подготовку,
 * после stop клавиатуру получает подтверждение. Очистка завершена до возврата.
 */
export async function runAddPreparation<T>(
  streams: PromptStreams,
  label: string,
  operation: (signal: AbortSignal, stop: () => void) => Promise<T>,
  skipTerminal = false,
): Promise<T | null> {
  const controller = new AbortController();
  const signal = streams.signal
    ? AbortSignal.any([streams.signal, controller.signal])
    : controller.signal;
  if (skipTerminal || !streams.input.isTTY || !streams.output.isTTY)
    return operation(signal, () => {});
  let terminalError: unknown;
  let preparing = true;
  const cancel = () => {
    if (preparing) controller.abort();
  };
  const fail = (cause: unknown) => {
    terminalError ??= cause;
    cancel();
  };
  const loading = createLoading(streams, undefined, fail);
  const session = terminalSession(streams, {
    key: (_value, key) => {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) cancel();
    },
    end: cancel,
    error: fail,
  });
  /** Останавливает индикатор и освобождает ввод даже при ошибке очистки кадра. */
  const stop = () => {
    preparing = false;
    let failure: unknown;
    try {
      loading.stop();
    } catch (cause) {
      failure = cause;
    }
    const releaseError = session.releaseInput();
    if (failure !== undefined) throw failure;
    if (releaseError !== undefined) throw releaseError;
  };
  let result: T | null = null;
  let error: unknown;
  try {
    session.start();
    if (
      streams.input.destroyed ||
      streams.input.readableEnded ||
      streams.output.destroyed ||
      streams.output.writableEnded
    )
      cancel();
    loading.start(label);
    signal.throwIfAborted();
    result = await operation(signal, stop);
  } catch (cause) {
    if (!isCancellation(cause, signal)) error = cause;
  }
  try {
    stop();
  } catch (cause) {
    error ??= cause;
  }
  const cleanupError = session.close();
  if (terminalError !== undefined) throw terminalError;
  if (error !== undefined) throw error;
  if (cleanupError !== undefined) throw cleanupError;
  return result;
}
