import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';

/** Подменяемый I/O архива; тесты используют настоящий разбор tar/gzip. */
export const archiveSourceFileSystem = {
  lstat: (path: string | Buffer) => lstat(path, { bigint: true }),
  mkdir,
  mkdtemp: (prefix: string) => mkdtemp(prefix),
  open,
  readFile,
  realpath,
  rm,
};
export type ArchiveSourceFileSystem = typeof archiveSourceFileSystem;

/** Ограниченные повторы разрешены только при удалении собственного workspace адаптера. */
export const OWNED_WORKSPACE_CLEANUP = Object.freeze({
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100,
});

/**
 * После неудачной подготовки удаляет только созданный адаптером workspace с ограниченными retry.
 * Без workspace или после успешной очистки выбрасывает исходную причину, включая отмену.
 * При отказе rm передаёт обе причины адаптеру: он задаёт тип ошибки, сообщение и путь для восстановления.
 * @remarks Вызывается после закрытия handles; владение успешным PreparedSource не меняет.
 */
export async function cleanupFailedPreparation(
  workspace: string | undefined,
  error: unknown,
  fileSystem: Pick<ArchiveSourceFileSystem, 'rm'>,
  cleanupFailure: (cause: AggregateError) => Error,
): Promise<never> {
  if (workspace !== undefined) {
    try {
      await fileSystem.rm(workspace, OWNED_WORKSPACE_CLEANUP);
    } catch (cleanupError) {
      throw cleanupFailure(new AggregateError([error, cleanupError]));
    }
  }
  throw error;
}

/** Узкий файловый I/O для воспроизводимых ошибок чтения/копирования с байтовыми именами. */
export interface DirectorySourceFileSystem {
  readonly lstat: (path: Buffer) => Promise<BigIntStats>;
  readonly realpath: (path: Buffer) => Promise<Buffer>;
  readonly readdir: (path: Buffer) => Promise<Buffer[]>;
  readonly mkdir: typeof mkdir;
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly open: typeof open;
  readonly readFile: (
    path: string,
    options: 'utf8' | { encoding: 'utf8'; signal?: AbortSignal | undefined },
  ) => Promise<string>;
  readonly rm: typeof rm;
}

/** Реальный I/O папки: сохраняет байтовые имена и использует BigIntStats для проверки inode. */
export const directorySourceFileSystem: DirectorySourceFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  realpath: (path) => realpath(path, { encoding: 'buffer' }),
  readdir: (path) => readdir(path, { encoding: 'buffer' }),
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
};
