import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { StateError, hasErrorCode } from './errors.ts';
import { assertScopeLocation } from './filesystem.ts';
import { assertSourceCompatible } from './identity.ts';
import { withScopeLock } from './mutex.ts';
import { LOCK_TEMP_PREFIX, type StatePaths } from './paths.ts';
import { parseLockFile, serializeLockFile } from './schema.ts';
import type { LockFile } from './types.ts';

export interface StateFileIO {
  readonly writeTemporaryFile: (path: string, content: string) => Promise<void>;
  readonly rename: (source: string, destination: string) => Promise<void>;
}

export const defaultStateFileIO: StateFileIO = {
  async writeTemporaryFile(path, content) {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename,
};

export interface StateTransaction {
  readonly read: () => Promise<LockFile | null>;
  readonly write: (lock: LockFile) => Promise<void>;
}

export class StateStore {
  constructor(
    readonly paths: StatePaths,
    private readonly io: StateFileIO = defaultStateFileIO,
  ) {}

  /** null means missing, while malformed/unsupported data and I/O errors reject. */
  async read(): Promise<LockFile | null> {
    await assertScopeLocation(this.paths);
    const root = await lstat(this.paths.root).catch((cause: unknown) => {
      if (hasErrorCode(cause, 'ENOENT')) return null;
      throw cause;
    });
    if (root === null) return null;
    if (!root.isDirectory() || root.isSymbolicLink())
      throw new StateError('INVALID_PATH', 'State root must be a regular directory.');
    const handle = await open(
      this.paths.lockPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((cause: unknown) => {
      if (hasErrorCode(cause, 'ENOENT')) return null;
      if (hasErrorCode(cause, 'ELOOP'))
        throw new StateError('INVALID_LOCK', 'Lock file cannot be a symlink.', { cause });
      throw cause;
    });
    if (handle === null) return null;
    try {
      if (!(await handle.stat()).isFile())
        throw new StateError('INVALID_LOCK', 'Lock must be a regular file.');
      let parsed: unknown;
      try {
        parsed = JSON.parse(await handle.readFile('utf8'));
      } catch (cause) {
        if (cause instanceof SyntaxError)
          throw new StateError('INVALID_LOCK', 'Invalid lock JSON.', { cause });
        throw cause;
      }
      return parseLockFile(parsed, this.paths);
    } finally {
      await handle.close();
    }
  }

  async transaction<T>(run: (state: StateTransaction) => Promise<T>): Promise<T> {
    return withScopeLock(this.paths, async () => {
      let active = true;
      const assertActive = () => {
        if (!active) throw new StateError('SCOPE_BUSY', 'State transaction has already ended.');
      };
      const transaction: StateTransaction = {
        read: async () => {
          assertActive();
          return this.read();
        },
        write: async (lock) => {
          assertActive();
          await this.writeAtomic(lock);
        },
      };
      try {
        return await run(transaction);
      } finally {
        active = false;
      }
    });
  }

  /** Serialize the whole read-modify-write operation under the scope lock. */
  async update(
    change: (previous: LockFile | null) => Promise<LockFile> | LockFile,
  ): Promise<LockFile> {
    return this.transaction(async (state) => {
      const next = await change(await state.read());
      const normalized = parseLockFile(JSON.parse(serializeLockFile(next, this.paths)), this.paths);
      await state.write(normalized);
      return normalized;
    });
  }

  async write(lock: LockFile): Promise<void> {
    return this.transaction((state) => state.write(lock));
  }

  private async writeAtomic(lock: LockFile): Promise<void> {
    const content = serializeLockFile(lock, this.paths);
    const next = parseLockFile(JSON.parse(content), this.paths);
    const previous = await this.read();
    if (previous !== null) {
      for (const record of Object.values(next.skills)) {
        assertSourceCompatible(previous, record.name, record.source, this.paths);
      }
    }
    const temporaryPath = join(this.paths.root, `${LOCK_TEMP_PREFIX}${randomUUID()}.tmp`);
    let committed = false;
    try {
      await this.io.writeTemporaryFile(temporaryPath, content);
      await this.io.rename(temporaryPath, this.paths.lockPath);
      committed = true;
    } finally {
      if (!committed)
        await unlink(temporaryPath).catch((cause: unknown) => {
          if (!hasErrorCode(cause, 'ENOENT')) throw cause;
        });
    }
  }
}
