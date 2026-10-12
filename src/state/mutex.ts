import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { StateError, hasErrorCode } from './errors.ts';
import { assertScopeLocation, ensureOwnedDirectory } from './filesystem.ts';
import type { StatePaths } from './paths.ts';

/** Fail fast on another writer, including a leftover lock after a crash. */
export async function withScopeLock<T>(paths: StatePaths, run: () => Promise<T>): Promise<T> {
  await assertScopeLocation(paths);
  await ensureOwnedDirectory(paths.root);
  const handle = await open(paths.operationLockPath, 'wx', 0o600).catch((cause: unknown) => {
    if (hasErrorCode(cause, 'EEXIST')) {
      throw new StateError('SCOPE_BUSY', `Scope is busy: ${paths.operationLockPath}.`, { cause });
    }
    throw cause;
  });
  let owner: Stats | undefined;
  try {
    owner = await handle.stat();
    await handle.writeFile(`${process.pid}:${randomUUID()}\n`, 'utf8');
    return await run();
  } finally {
    try {
      const current = await lstat(paths.operationLockPath).catch((cause: unknown) => {
        if (hasErrorCode(cause, 'ENOENT')) return null;
        throw cause;
      });
      if (current && (!owner || (current.dev === owner.dev && current.ino === owner.ino)))
        await unlink(paths.operationLockPath);
    } finally {
      await handle.close();
    }
  }
}
