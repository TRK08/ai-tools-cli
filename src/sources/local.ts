import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hasErrorCode } from '../state/errors.ts';
import { prepareArchive } from './archive.ts';
import { prepareDirectory, type PrepareDirectoryOptions } from './directory.ts';

export async function localSourceIdentity(source: string, cwd: string) {
  const path = resolve(cwd, source);
  let archive = /\.(?:tar\.gz|tgz)$/.test(source);
  if (archive) {
    try {
      archive = !(await stat(path)).isDirectory();
    } catch (cause) {
      if (!hasErrorCode(cause, 'ENOENT') && !hasErrorCode(cause, 'ENOTDIR')) throw cause;
    }
  }
  return {
    kind: archive ? ('archive' as const) : ('directory' as const),
    path,
  };
}

export async function prepareLocalSource(source: string, options: PrepareDirectoryOptions) {
  return (await localSourceIdentity(source, options.cwd)).kind === 'archive'
    ? prepareArchive(source, { cwd: options.cwd, temporaryDirectory: options.temporaryDirectory })
    : prepareDirectory(source, options);
}
