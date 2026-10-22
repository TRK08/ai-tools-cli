/** Операции состояния, хеша и путей установок; I/O начинается при вызове операций. */
export { assertScopeLocation } from './filesystem';
export { hashDirectory } from './hash';
export { assertSourceCompatible, sourceIdentityKey } from './identity';
export {
  INSTALLER_LOCK_NAME,
  LOCK_TEMP_PREFIX,
  WORKSPACE_PREFIX,
  assertSkillName,
  getSkillDirectory,
  getStatePaths,
  portableConnectionPath,
  portableSourcePath,
  resolveConnectionPath,
  resolveSourcePath,
  validatePathText,
} from './paths';
export type { StatePaths } from './paths';
export { StateStore } from './store';
export type { StateTransaction } from './store';
export { createEmptyLock } from './types';
export type { InstallationRecord, LockFile, ManagedConnection } from './types';
