export type StateErrorCode =
  | 'INVALID_PATH'
  | 'INVALID_LOCK'
  | 'UNSUPPORTED_LOCK_VERSION'
  | 'SOURCE_CONFLICT'
  | 'SCOPE_BUSY'
  | 'PROJECT_IN_HOME';

export const PROJECT_IN_HOME_MESSAGE =
  'Локальная область недоступна в домашнем каталоге. Выберите другую рабочую папку или используйте --global.';

export class StateError extends Error {
  constructor(
    readonly code: StateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StateError';
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
