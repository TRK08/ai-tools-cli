import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';

/** Подменяемый I/O архива; тесты используют настоящий разбор tar/gzip. */
export const archiveSourceFileSystem = { lstat, mkdir, mkdtemp, open, readFile, realpath, rm };
export type ArchiveSourceFileSystem = typeof archiveSourceFileSystem;

/** Узкий файловый I/O для воспроизводимых ошибок чтения/копирования с байтовыми именами. */
export interface DirectorySourceFileSystem {
  readonly lstat: (path: Buffer) => Promise<BigIntStats>;
  readonly realpath: (path: Buffer) => Promise<Buffer>;
  readonly readdir: (path: Buffer) => Promise<Buffer[]>;
  readonly mkdir: typeof mkdir;
  readonly mkdtemp: typeof mkdtemp;
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
