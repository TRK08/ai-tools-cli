import type { SourceIdentity } from '@/sources/types';
import { StateError } from '@/errors';
import { resolveSourcePath, type StatePaths } from './paths';
import { pathIdentityKey } from '@/paths';
import type { LockFile } from './types';

/** Проверяет базовый HTTP(S) URL источника и удаляет завершающие слеши; неверный URL даёт INVALID_LOCK. */
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

/**
 * Строит постоянный ключ источника из типа и пути либо registry URL/slug. Версия, digest и временный URL
 * в идентичность не входят.
 */
export function sourceIdentityKey(source: SourceIdentity, paths: StatePaths): string {
  return source.kind === 'registry'
    ? JSON.stringify([source.kind, normalizeRegistryUrl(source.registryUrl), source.slug])
    : JSON.stringify([source.kind, pathIdentityKey(resolveSourcePath(source.path, paths))]);
}

/** Запрещает менять постоянный источник уже установленного имени; для смены требуется remove и add. */
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
