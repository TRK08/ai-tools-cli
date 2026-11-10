export type StateErrorCode =
  'INVALID_PATH' | 'INVALID_LOCK' | 'SOURCE_CONFLICT' | 'SCOPE_BUSY' | 'PROJECT_IN_HOME';

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

const filesystemMessages: Record<string, string> = {
  EACCES: 'Нет доступа',
  EPERM: 'Операция запрещена',
  ENOENT: 'Файл или каталог не найден',
  ENOTDIR: 'Ожидался каталог',
  EISDIR: 'Ожидался файл, обнаружен каталог',
  EEXIST: 'Объект уже существует',
  ENOTEMPTY: 'Каталог не пуст',
  ELOOP: 'Обнаружен цикл символических ссылок',
  ENOSPC: 'Недостаточно места на диске',
  EROFS: 'Файловая система доступна только для чтения',
  EMFILE: 'Открыто слишком много файлов',
  ENFILE: 'Превышен системный предел открытых файлов',
  EIO: 'Ошибка ввода-вывода',
  EXDEV: 'Нельзя переместить объект между файловыми системами',
  EBUSY: 'Объект занят',
  ENAMETOOLONG: 'Имя файла слишком длинное',
};

/**
 * Возвращает русское сообщение для системной ошибки файловой системы, сохраняя код, операцию и пути. Для
 * остальных ошибок сохраняет исходное сообщение, для иных значений использует String.
 */
export function errorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const error = cause as NodeJS.ErrnoException & { dest?: string };
  if (error.code && error.syscall)
    return `${filesystemMessages[error.code] ?? 'Ошибка файловой системы'} (${error.code}; операция: ${error.syscall})${error.path ? `: ${error.path}` : ''}${error.dest ? ` → ${error.dest}` : ''}.`;
  return cause.message;
}
