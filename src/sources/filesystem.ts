import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';

/** Archive I/O seam; parsing uses the real tar/gzip implementation in tests. */
export const archiveSourceFileSystem = { lstat, mkdir, mkdtemp, open, readFile, realpath, rm };
export type ArchiveSourceFileSystem = typeof archiveSourceFileSystem;

/** Narrow filesystem seam for deterministic read/copy failure tests. */
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
