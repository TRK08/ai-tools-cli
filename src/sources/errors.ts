export type SourceErrorCode =
  | 'INVALID_SOURCE'
  | 'INVALID_METADATA'
  | 'SOURCE_CYCLE'
  | 'UNSUPPORTED_ENTRY'
  | 'PREPARATION_FAILED';

export class SourceError extends Error {
  constructor(
    readonly code: SourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SourceError';
  }
}
