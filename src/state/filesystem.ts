import { lstat, mkdir, stat } from 'node:fs/promises';
import { PROJECT_IN_HOME_MESSAGE, StateError, hasErrorCode } from './errors.ts';
import type { StatePaths } from './paths.ts';

/**
 * Отклоняет проектную область, совпадающую с home по inode, включая symlink-алиас. Проверяется до чтения
 * состояния, создания каталогов и захвата блокировки.
 */
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

/**
 * Создаёт каталог состояния при отсутствии и проверяет, что конечный объект — обычный каталог, а не
 * ссылка.
 */
export async function ensureOwnedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new StateError(
      'INVALID_PATH',
      `Каталог состояния должен быть обычным каталогом: ${path}.`,
    );
  }
}
