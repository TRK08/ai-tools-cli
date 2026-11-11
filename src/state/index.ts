/** Операции состояния, хеша и путей установок; I/O начинается при вызове операций. */
export { assertScopeLocation } from './filesystem';
export { hashDirectory } from './hash';
export {
  INSTALLER_LOCK_NAME,
  LOCK_TEMP_PREFIX,
  WORKSPACE_PREFIX,
  assertSkillName,
  getSkillDirectory,
  getStatePaths,
  portableConnectionPath,
  resolveConnectionPath,
  validatePathText,
} from './paths';
export type { StatePaths } from './paths';
export { StateStore } from './store';
export type { StateTransaction } from './store';
export { createEmptyLock } from './types';
export type { InstalledPackage, InstalledSkill, LockFile, ManagedConnection } from './types';

export { withFileLock } from './mutex';
