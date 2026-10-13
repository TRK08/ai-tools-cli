import { isAbsolute, join, relative, resolve } from 'node:path';
import type { InstallationScope } from '../installer/types.ts';
import type { FileSystemRoots } from '../runtime.ts';
import { PROJECT_IN_HOME_MESSAGE, StateError } from './errors.ts';

export const INSTALLER_LOCK_NAME = 'skills-installer-lock.json';
export const WORKSPACE_PREFIX = '.skills-installer-work-';
export const LOCK_TEMP_PREFIX = '.skills-installer-lock-';

export interface StatePaths extends FileSystemRoots {
  readonly scope: InstallationScope;
  readonly root: string;
  readonly skillsDirectory: string;
  readonly lockPath: string;
  readonly operationLockPath: string;
  readonly agentsDirectory: string;
}

/**
 * Вычисляет нормализованные пути состояния и общей копии для выбранной области без I/O.
 *
 * @throws StateError — корни не абсолютны либо проектная область лексически совпадает с home.
 */
export function getStatePaths(roots: FileSystemRoots, scope: InstallationScope): StatePaths {
  if (!isAbsolute(roots.cwd) || !isAbsolute(roots.home)) {
    throw new StateError(
      'INVALID_PATH',
      'Пути рабочей папки и домашнего каталога должны быть абсолютными.',
    );
  }
  const cwd = resolve(roots.cwd);
  const home = resolve(roots.home);
  if (scope === 'project' && cwd === home) {
    throw new StateError('PROJECT_IN_HOME', PROJECT_IN_HOME_MESSAGE);
  }
  const base = scope === 'project' ? cwd : home;
  const agentsDirectory = join(base, '.agents');
  const root = scope === 'project' ? cwd : agentsDirectory;
  return Object.freeze({
    cwd,
    home,
    scope,
    root,
    agentsDirectory,
    skillsDirectory: join(agentsDirectory, 'skills'),
    lockPath: join(root, INSTALLER_LOCK_NAME),
    operationLockPath: join(root, '.skills-installer-operation.lock'),
  });
}

/**
 * Проверяет непустое имя каталога: запрещает разделители, управляющие символы и «.»/«..», ограничивает
 * длину 255 байтами UTF-8.
 */
export function assertSkillName(name: string): void {
  if (
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    /[/\\\p{Cc}]/u.test(name) ||
    Buffer.byteLength(name, 'utf8') > 255
  ) {
    throw new StateError('INVALID_PATH', `Небезопасное имя скилла: ${JSON.stringify(name)}.`);
  }
}

/** Проверяет имя и вычисляет каталог общей копии скилла, не создавая его. */
export function getSkillDirectory(paths: StatePaths, name: string): string {
  assertSkillName(name);
  return join(paths.skillsDirectory, name);
}

/** Отклоняет пустые POSIX-пути, обратные слеши и управляющие символы. */
export function validatePathText(path: string): void {
  if (!path || /[\\\p{Cc}]/u.test(path)) {
    throw new StateError(
      'INVALID_PATH',
      'Пути должны быть непустыми путями POSIX без управляющих символов.',
    );
  }
}

/**
 * Кодирует источник относительным путём в проекте и абсолютным — глобально. Локальный источник может
 * находиться вне cwd; symlink не разыменовывается.
 */
export function portableSourcePath(path: string, paths: StatePaths): string {
  validatePathText(path);
  const absolute = resolve(paths.cwd, path);
  return paths.scope === 'global' ? absolute : relative(paths.cwd, absolute) || '.';
}

/** Разрешает сохранённый путь источника относительно cwd, сохраняя лексическую идентичность. */
export function resolveSourcePath(path: string, paths: StatePaths): string {
  validatePathText(path);
  return resolve(paths.cwd, path);
}

/**
 * Кодирует управляемое назначение, запрещая выход проектного пути за cwd. Глобальное назначение должно
 * быть абсолютным.
 */
export function portableConnectionPath(path: string, paths: StatePaths): string {
  validatePathText(path);
  if (paths.scope === 'global') {
    if (!isAbsolute(path)) {
      throw new StateError('INVALID_PATH', 'Пути глобальных подключений должны быть абсолютными.');
    }
    return resolve(path);
  }
  const portable = relative(paths.cwd, resolve(paths.cwd, path));
  if (!portable || portable === '..' || portable.startsWith('../') || isAbsolute(portable)) {
    throw new StateError(
      'INVALID_PATH',
      'Подключения проекта должны находиться внутри рабочей папки.',
    );
  }
  return portable;
}

/** Получает абсолютный путь подключения после проверки правил переносимости области. */
export function resolveConnectionPath(path: string, paths: StatePaths): string {
  return paths.scope === 'project'
    ? join(paths.cwd, portableConnectionPath(path, paths))
    : portableConnectionPath(path, paths);
}
