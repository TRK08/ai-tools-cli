export type StateErrorCode =
  'INVALID_PATH' | 'INVALID_LOCK' | 'SOURCE_CONFLICT' | 'SCOPE_BUSY' | 'PROJECT_IN_HOME';

export const PROJECT_IN_HOME_MESSAGE =
  'Локальная область недоступна в домашнем каталоге. Выберите другую рабочую папку или используйте --global.';

export class StateError extends Error {
  /** Сохраняет код ошибки состояния/пути и её исходную причину для диагностики. */
  constructor(
    readonly code: StateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StateError';
  }
}

/** Проверяет поле code у экземпляра Error, не принимая произвольные объекты за системные ошибки. */
export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
