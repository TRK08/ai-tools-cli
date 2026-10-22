import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { StateError, hasErrorCode } from '@/errors';
import { assertScopeLocation, ensureOwnedDirectory } from './filesystem';
import type { StatePaths } from './paths';

/** Подменяемый I/O блокировки; файловые IDs сравниваются без потери точности. */
export const scopeLockFileSystem = {
  open,
  lstat: (path: string) => lstat(path, { bigint: true }),
  unlink,
};

/**
 * Удерживает wx-блокировку области до завершения callback; stale lock даёт SCOPE_BUSY.
 * Удаляет только подтверждённый собственный обычный файл по BigInt identity и закрывает handle.
 * При неизвестном владельце файл остаётся; ошибки операции, освобождения и close не скрывают друг друга.
 */
export async function withScopeLock<T>(
  paths: StatePaths,
  run: () => Promise<T>,
  fs = scopeLockFileSystem,
): Promise<T> {
  await assertScopeLocation(paths);
  await ensureOwnedDirectory(paths.root);
  const handle = await fs.open(paths.operationLockPath, 'wx', 0o600).catch((cause: unknown) => {
    if (hasErrorCode(cause, 'EEXIST')) {
      throw new StateError(
        'SCOPE_BUSY',
        `Область занята другой операцией: ${paths.operationLockPath}.`,
        { cause },
      );
    }
    throw cause;
  });
  let owner: BigIntStats | undefined;
  let result!: T;
  const errors: unknown[] = [];
  try {
    owner = await handle.stat({ bigint: true });
    if (!owner.isFile()) throw new Error('Блокировка должна быть обычным файлом.');
    await handle.writeFile(`${process.pid}:${randomUUID()}\n`, 'utf8');
    result = await run();
  } catch (cause) {
    errors.push(cause);
  } finally {
    try {
      if (owner?.isFile()) {
        const current = await fs.lstat(paths.operationLockPath).catch((cause: unknown) => {
          if (hasErrorCode(cause, 'ENOENT')) return null;
          throw cause;
        });
        if (current?.isFile() && current.dev === owner.dev && current.ino === owner.ino)
          await fs.unlink(paths.operationLockPath);
      }
    } catch (cause) {
      errors.push(cause);
    }
    try {
      await handle.close();
    } catch (cause) {
      errors.push(cause);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'Операция и освобождение блокировки завершились ошибками.');
  return result;
}
