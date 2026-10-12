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

export function getStatePaths(roots: FileSystemRoots, scope: InstallationScope): StatePaths {
  if (!isAbsolute(roots.cwd) || !isAbsolute(roots.home)) {
    throw new StateError('INVALID_PATH', 'State roots must be absolute cwd and home paths.');
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

export function assertSkillName(name: string): void {
  if (
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    /[/\\\p{Cc}]/u.test(name) ||
    Buffer.byteLength(name, 'utf8') > 255
  ) {
    throw new StateError('INVALID_PATH', `Unsafe skill name: ${JSON.stringify(name)}.`);
  }
}

export function getSkillDirectory(paths: StatePaths, name: string): string {
  assertSkillName(name);
  return join(paths.skillsDirectory, name);
}

export function validatePathText(path: string): void {
  if (!path || /[\\\p{Cc}]/u.test(path)) {
    throw new StateError(
      'INVALID_PATH',
      'Paths must be nonempty POSIX paths without control characters.',
    );
  }
}

/** Local sources may be outside cwd; their identity remains lexical and does not follow symlinks. */
export function portableSourcePath(path: string, paths: StatePaths): string {
  validatePathText(path);
  const absolute = resolve(paths.cwd, path);
  return paths.scope === 'global' ? absolute : relative(paths.cwd, absolute) || '.';
}

export function resolveSourcePath(path: string, paths: StatePaths): string {
  validatePathText(path);
  return resolve(paths.cwd, path);
}

/** Managed project connections must stay inside the selected cwd. */
export function portableConnectionPath(path: string, paths: StatePaths): string {
  validatePathText(path);
  if (paths.scope === 'global') {
    if (!isAbsolute(path)) {
      throw new StateError('INVALID_PATH', 'Global connection paths must be absolute.');
    }
    return resolve(path);
  }
  const portable = relative(paths.cwd, resolve(paths.cwd, path));
  if (!portable || portable === '..' || portable.startsWith('../') || isAbsolute(portable)) {
    throw new StateError('INVALID_PATH', 'Project connections must stay inside cwd.');
  }
  return portable;
}

export function resolveConnectionPath(path: string, paths: StatePaths): string {
  return paths.scope === 'project'
    ? join(paths.cwd, portableConnectionPath(path, paths))
    : portableConnectionPath(path, paths);
}
