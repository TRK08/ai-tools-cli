import { terminalSession } from './session.ts';
import { createScreen } from './screen.ts';
import type { PromptStreams, PromptController, PromptHandlers } from './types.ts';

/**
 * Запускает диалог с общим владением session, кадром и AbortSignal.
 * EOF/Esc/Ctrl+C дают null; ошибки setup/render/потоков сохраняются после всех шагов очистки.
 * clearOnExit определяет политику финального кадра; cleanup выполняется до освобождения экрана.
 */
export function runPrompt<Value>(
  streams: PromptStreams,
  create: (controller: PromptController<Value>) => PromptHandlers<Value>,
  options: { readonly signal?: AbortSignal; readonly clearOnExit?: boolean } = {},
): Promise<Value | null> {
  const { input, output } = streams;
  const unavailable = () =>
    options.signal?.aborted ||
    input.destroyed ||
    input.readableEnded ||
    output.destroyed ||
    output.writableEnded;
  if (unavailable()) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const screen = createScreen(output);
    let closed = false;
    let handlers: PromptHandlers<Value> | undefined;
    let session: ReturnType<typeof terminalSession> | undefined;
    const cancel = () => finish(null);

    /** Завершает один раз и пробует все шаги очистки, сохраняя исходную ошибку. */
    function finish(value: Value | null, error?: unknown) {
      if (closed) return;
      closed = true;
      options.signal?.removeEventListener('abort', cancel);
      const cleanup = [
        () => {
          if (error === undefined) handlers?.settled?.(value);
        },
        ...(handlers?.cleanup ?? []),
        () => screen.close(options.clearOnExit !== false),
        () => {
          const failure = session?.close();
          if (failure !== undefined) throw failure;
        },
      ];
      for (const operation of cleanup) {
        try {
          operation();
        } catch (cause) {
          error ??= cause;
        }
      }
      if (error !== undefined) reject(error);
      else resolve(value);
    }
    /** Перерисовывает активный диалог; ошибка renderer завершает его с общей очисткой. */
    function render() {
      if (closed) return;
      try {
        handlers?.render();
      } catch (cause) {
        finish(null, cause);
      }
    }
    try {
      handlers = create({
        screen,
        finish,
        render,
        get closed() {
          return closed;
        },
      });
      session = terminalSession(streams, {
        key: (character, key) => {
          if (closed) return;
          try {
            if (key.name === 'escape' || (key.ctrl && key.name === 'c')) cancel();
            else handlers!.key(character, key);
          } catch (cause) {
            finish(null, cause);
          }
        },
        end: cancel,
        error: (cause) => finish(null, cause),
        resize: render,
      });
      options.signal?.addEventListener('abort', cancel, { once: true });
      session.start();
      if (closed) return;
      if (unavailable()) return cancel();
      screen.hideCursor();
      handlers.start?.();
      render();
    } catch (cause) {
      finish(null, cause);
    }
  });
}
