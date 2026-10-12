import { lstat, mkdir, stat } from 'node:fs/promises';
import { PROJECT_IN_HOME_MESSAGE, StateError, hasErrorCode } from './errors.ts';
import type { StatePaths } from './paths.ts';

/** Detect aliases of home before any state read, directory creation or lock acquisition. */
export async function assertScopeLocation(paths: StatePaths): Promise<void> {
  if (paths.scope !== 'project') return;
  const inspect = async (path: string) =>
    stat(path, { bigint: true }).catch((cause: unknown) => {
      if (hasErrorCode(cause, 'ENOENT')) return null;
      throw cause;
    });
  const [cwd, home] = await Promise.all([inspect(paths.cwd), inspect(paths.home)]);
  if (cwd && home && cwd.dev === home.dev && cwd.ino === home.ino) {
    throw new StateError('PROJECT_IN_HOME', PROJECT_IN_HOME_MESSAGE);
  }
}

export async function ensureOwnedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new StateError('INVALID_PATH', `State directory must be a regular directory: ${path}.`);
  }
}
