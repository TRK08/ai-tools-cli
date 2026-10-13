/** Recognize only this operation's abort, never an unrelated failure during cleanup. */
export function isCancellation(cause: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true &&
    (cause === signal.reason ||
      (cause instanceof Error && cause.name === 'AbortError' && cause.cause === signal.reason))
  );
}
