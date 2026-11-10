import { setTimeout as delay } from 'node:timers/promises';
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
  return withFileLock(paths.operationLockPath, run, {}, fs);
}

/**
 * Удерживает файловую wx-блокировку до очистки callback; ожидание отменяемо, чужой/stale lock не удаляет.
 * При тайм-ауте сообщает путь для ручной диагностики; освобождает только свой inode без signal.
 */
export async function withFileLock<T>(
  path: string,
  run: () => Promise<T>,
  options: { signal?: AbortSignal; waitMs?: number } = {},
  fs = scopeLockFileSystem,
): Promise<T> {
  const deadline = Date.now() + (options.waitMs ?? 0);
  const acquire = async () => {
    for (;;) {
      options.signal?.throwIfAborted();
      try {
        return await fs.open(path, 'wx', 0o600);
      } catch (cause) {
        if (!hasErrorCode(cause, 'EEXIST')) throw cause;
        if (Date.now() >= deadline)
          throw new StateError(
            'SCOPE_BUSY',
            `Область занята другой операцией или осталась блокировка: ${path}. Проверьте владельца и recovery-каталоги; автоматического удаления нет.`,
            { cause },
          );
        await delay(50, undefined, { signal: options.signal });
      }
    }
  };
  const handle = await acquire();
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
        const current = await fs.lstat(path).catch((cause: unknown) => {
          if (hasErrorCode(cause, 'ENOENT')) return null;
          throw cause;
        });
        if (current?.isFile() && current.dev === owner.dev && current.ino === owner.ino)
          await fs.unlink(path);
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
