import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

/**
 * Передаёт открытый handle операции и закрывает его до возврата результата или ошибки.
 * Владение handle переходит сюда; одновременные ошибки операции и close сохраняются в AggregateError.
 */
export async function withFileHandle<T>(
  handle: FileHandle,
  run: (handle: FileHandle) => Promise<T>,
): Promise<T> {
  let result!: T;
  const errors: unknown[] = [];
  try {
    result = await run(handle);
  } catch (cause) {
    errors.push(cause);
  }
  try {
    await handle.close();
  } catch (cause) {
    errors.push(cause);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'Операция и закрытие файла завершились ошибками.');
  return result;
}

/** Сохраняет POSIX-права подготовленного файла; Unix chmod на Windows не требуется. */
export async function preserveFileMode(handle: FileHandle, mode: number): Promise<void> {
  if (process.platform !== 'win32') await handle.chmod(mode);
}

export interface RegularFileIO<Path extends string | Buffer = string | Buffer> {
  readonly lstat: (path: Path) => Promise<BigIntStats>;
  readonly open: typeof open;
}

/** Сверяет identity обычного файла; ссылка, каталог и иной объект не принимаются. */
function sameFile(first: BigIntStats, second: BigIntStats): boolean {
  return first.isFile() && second.isFile() && first.dev === second.dev && first.ino === second.ino;
}

/** Создаёт reader с системными флагами; подмена платформы допустима только в тестах этого I/O-helper. */
export function createRegularFileReader(platform: NodeJS.Platform = process.platform) {
  const flags =
    platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

  /**
   * Проверяет lstat до open, fstat и повторный lstat без разыменования конечной ссылки.
   * После успеха handle закрывает вызывающий; при ошибке/отмене reader закрывает его сам.
   * @remarks Защищает identity конечного файла, но не обещает атомарного снимка всего дерева.
   */
  return async function openRegularFile<Path extends string | Buffer>(
    path: Path,
    options: {
      readonly fileSystem?: RegularFileIO<Path>;
      readonly expected?: BigIntStats;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ) {
    const fs = options.fileSystem ?? { lstat: (path: Path) => lstat(path, { bigint: true }), open };
    const { signal } = options;
    signal?.throwIfAborted();
    const before = await fs.lstat(path);
    signal?.throwIfAborted();
    if (!before.isFile() || (options.expected && !sameFile(before, options.expected)))
      throw new Error('Ожидался неизменённый обычный файл.');
    const handle = await fs.open(path, flags);
    try {
      signal?.throwIfAborted();
      const stats = await handle.stat({ bigint: true });
      signal?.throwIfAborted();
      const after = await fs.lstat(path);
      signal?.throwIfAborted();
      if (!sameFile(before, stats) || !sameFile(stats, after))
        throw new Error('Файл изменился во время открытия.');
      return { handle, stats };
    } catch (cause) {
      try {
        await handle.close();
      } catch (closeError) {
        throw new AggregateError(
          [cause, closeError],
          'Открытие и закрытие файла завершились ошибками.',
        );
      }
      throw cause;
    }
  };
}

/** Reader текущей ОС; флаги NOFOLLOW/NONBLOCK применяются только на POSIX. */
export const openRegularFile = createRegularFileReader();
