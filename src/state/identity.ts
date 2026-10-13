import type { SourceIdentity } from '../sources/types.ts';
import { StateError } from './errors.ts';
import { resolveSourcePath, type StatePaths } from './paths.ts';
import type { LockFile } from './types.ts';

export function normalizeRegistryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new StateError('INVALID_LOCK', 'Источник реестра должен содержать базовый HTTP(S) URL.', {
      cause,
    });
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new StateError(
      'INVALID_LOCK',
      'Базовый URL реестра не может содержать учётные данные, параметры или фрагмент.',
    );
  }
  return url.href.replace(/\/+$/, '');
}

/** Versions and digests are deliberately excluded from permanent identity. */
export function sourceIdentityKey(source: SourceIdentity, paths: StatePaths): string {
  return source.kind === 'registry'
    ? JSON.stringify([source.kind, normalizeRegistryUrl(source.registryUrl), source.slug])
    : JSON.stringify([source.kind, resolveSourcePath(source.path, paths)]);
}

export function assertSourceCompatible(
  lock: LockFile,
  name: string,
  source: SourceIdentity,
  paths: StatePaths,
): void {
  const existing = Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
  if (existing && sourceIdentityKey(existing.source, paths) !== sourceIdentityKey(source, paths)) {
    throw new StateError(
      'SOURCE_CONFLICT',
      `У скилла ${JSON.stringify(name)} уже есть другой источник; удалите его перед установкой из нового источника.`,
    );
  }
}
