import { lstat, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hasErrorCode } from '../state/errors.ts';
import { parseRegistryReference } from '../registry/reference.ts';
import { prepareArchive } from './archive.ts';
import { prepareDirectory, type PrepareDirectoryOptions } from './directory.ts';

/**
 * Определяет registry-ссылку с приоритетом существующего локального пути, включая symlink.
 *
 * @returns null для локального/явного пути, архивного суффикса либо строки, не являющейся slug.
 */
export async function registryReferenceForSource(source: string, cwd: string) {
  if (/\.(?:tar\.gz|tgz)$/.test(source)) return null;
  try {
    await lstat(resolve(cwd, source));
    return null;
  } catch (cause) {
    if (!hasErrorCode(cause, 'ENOENT') && !hasErrorCode(cause, 'ENOTDIR')) throw cause;
  }
  return parseRegistryReference(source);
}

/**
 * Возвращает тип локального источника и его абсолютный лексический путь. Папка с суффиксом .tgz остаётся
 * папкой; identity не заменяется разыменованным путём.
 */
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

/**
 * Выбирает адаптер папки или архива и передаёт ему временную базу и сигнал отмены. Владение возвращённым
 * снимком определяется контрактом PreparedSource.
 */
export async function prepareLocalSource(source: string, options: PrepareDirectoryOptions) {
  options.signal?.throwIfAborted();
  return (await localSourceIdentity(source, options.cwd)).kind === 'archive'
    ? prepareArchive(source, {
        cwd: options.cwd,
        temporaryDirectory: options.temporaryDirectory,
        signal: options.signal,
      })
    : prepareDirectory(source, options);
}
