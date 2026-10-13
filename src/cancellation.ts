/**
 * Распознаёт отмену именно переданной операции по signal.reason. Ошибки очистки и другие независимые сбои
 * не превращает в успешную отмену.
 */
export function isCancellation(cause: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true &&
    (cause === signal.reason ||
      (cause instanceof Error && cause.name === 'AbortError' && cause.cause === signal.reason))
  );
}
