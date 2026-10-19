import { posix } from 'node:path';
import type { InstallationScope } from '../installer/types.ts';
import type { FileSystemRoots } from '../runtime.ts';
import { PROJECT_IN_HOME_MESSAGE, StateError } from './errors.ts';
import { assertPortableName } from './names.ts';
import { isPathWithin, nativePath, samePath, validateNativePath } from './native-path.ts';

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
 * Вычисляет нативные пути состояния текущей ОС без I/O.
 * @throws StateError — корни не абсолютны/неподдерживаемы либо проект лексически совпадает с home.
 */
export function getStatePaths(roots: FileSystemRoots, scope: InstallationScope): StatePaths {
  const { isAbsolute, join, resolve } = nativePath;
  validatePathText(roots.cwd);
  validatePathText(roots.home);
  if (!isAbsolute(roots.cwd) || !isAbsolute(roots.home)) {
    throw new StateError(
      'INVALID_PATH',
      'Пути рабочей папки и домашнего каталога должны быть абсолютными.',
    );
  }
  const cwd = resolve(roots.cwd);
  const home = resolve(roots.home);
  if (scope === 'project' && samePath(cwd, home)) {
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

/** Проверяет переносимое имя скилла без переименования: правила Windows/POSIX и до 255 байт UTF-8. */
export function assertSkillName(name: string): void {
  try {
    assertPortableName(name);
  } catch (cause) {
    throw new StateError('INVALID_PATH', 'Небезопасное имя скилла: ' + JSON.stringify(name) + '.', {
      cause,
    });
  }
}

/** Проверяет имя и вычисляет каталог общей копии скилла, не создавая его. */
export function getSkillDirectory(paths: StatePaths, name: string): string {
  assertSkillName(name);
  return nativePath.join(paths.skillsDirectory, name);
}

/** Проверяет нативный путь по правилам текущей ОС, не выполняя файловых операций. */
export function validatePathText(path: string): void {
  validateNativePath(path);
}

/** Проверяет относительный путь проектного lock с разделителем / и переносимыми компонентами. */
export function validatePortablePathText(path: string): void {
  if (!path || /[\\\p{Cc}]/u.test(path) || posix.isAbsolute(path)) {
    throw new StateError(
      'INVALID_PATH',
      'Проектный путь должен быть относительным с разделителем /.',
    );
  }
  for (const part of path.split('/').filter(Boolean)) {
    if (part !== '.' && part !== '..') assertPortableName(part);
  }
}

/**
 * Кодирует источник относительно cwd в проекте и абсолютно глобально, без realpath.
 * Внешний источник проекта допустим на том же диске; другой диск отклоняется до подготовки.
 */
export function portableSourcePath(path: string, paths: StatePaths): string {
  const { resolve, relative, isAbsolute, sep } = nativePath;
  validatePathText(path);
  const absolute = resolve(paths.cwd, path);
  if (paths.scope === 'global') return absolute;
  const local = relative(paths.cwd, absolute);
  if (isAbsolute(local)) {
    throw new StateError('INVALID_PATH', 'Источник проекта должен находиться на том же диске.');
  }
  const portable = local.split(sep).join('/') || '.';
  validatePortablePathText(portable);
  return portable;
}

/** Разрешает источник относительно cwd без realpath; предварительно проверяет переносимость области. */
export function resolveSourcePath(path: string, paths: StatePaths): string {
  portableSourcePath(path, paths);
  return nativePath.resolve(paths.cwd, path);
}

/** Кодирует назначение: проектное строго внутри cwd с /, глобальное — абсолютный нативный путь. */
export function portableConnectionPath(path: string, paths: StatePaths): string {
  const { isAbsolute, resolve, relative, sep } = nativePath;
  validatePathText(path);
  if (paths.scope === 'global') {
    if (!isAbsolute(path)) {
      throw new StateError('INVALID_PATH', 'Пути глобальных подключений должны быть абсолютными.');
    }
    return resolve(path);
  }
  const absolute = resolve(paths.cwd, path);
  if (samePath(paths.cwd, absolute) || !isPathWithin(paths.cwd, absolute)) {
    throw new StateError(
      'INVALID_PATH',
      'Подключения проекта должны находиться внутри рабочей папки.',
    );
  }
  const portable = relative(paths.cwd, absolute).split(sep).join('/');
  validatePortablePathText(portable);
  return portable;
}

/** Получает абсолютный нативный путь назначения после проверки правил области. */
export function resolveConnectionPath(path: string, paths: StatePaths): string {
  return paths.scope === 'project'
    ? nativePath.resolve(paths.cwd, portableConnectionPath(path, paths))
    : portableConnectionPath(path, paths);
}
