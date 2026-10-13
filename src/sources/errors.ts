export type SourceErrorCode =
  | 'INVALID_SOURCE'
  | 'INVALID_METADATA'
  | 'INVALID_ARCHIVE'
  | 'ARCHIVE_LIMIT'
  | 'SOURCE_CYCLE'
  | 'UNSUPPORTED_ENTRY'
  | 'PREPARATION_FAILED';

export class SourceError extends Error {
  /** Сохраняет код ошибки подготовки и исходную причину, включая составную ошибку очистки. */
  constructor(
    readonly code: SourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SourceError';
  }
}
