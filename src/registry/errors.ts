export type RegistryErrorCode =
  | 'INVALID_REFERENCE'
  | 'INVALID_REGISTRY'
  | 'NOT_FOUND'
  | 'REGISTRY_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'DOWNLOAD_FAILED'
  | 'ARTIFACT_MISMATCH'
  | 'URL_EXPIRED';

export class RegistryError extends Error {
  /** Сохраняет код registry-ошибки, её причину и HTTP-статус для диагностики и обновления URL. */
  constructor(
    readonly code: RegistryErrorCode,
    message: string,
    options?: ErrorOptions,
    readonly status?: number,
  ) {
    super(message, options);
    this.name = 'RegistryError';
  }
}
