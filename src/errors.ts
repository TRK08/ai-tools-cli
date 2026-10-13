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

/** Preserve diagnostic codes, operations and paths while localizing native filesystem errors. */
export function errorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const error = cause as NodeJS.ErrnoException & { dest?: string };
  if (error.code && error.syscall)
    return `${filesystemMessages[error.code] ?? 'Ошибка файловой системы'} (${error.code}; операция: ${error.syscall})${error.path ? `: ${error.path}` : ''}${error.dest ? ` → ${error.dest}` : ''}.`;
  return cause.message;
}
