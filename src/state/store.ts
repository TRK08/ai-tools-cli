import { randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { StateError, hasErrorCode } from '@/errors';
import { assertScopeLocation } from './filesystem';
import { assertSourceCompatible } from './identity';
import { withScopeLock } from './mutex';
import { LOCK_TEMP_PREFIX, type StatePaths } from './paths';
import { parseLockFile, serializeLockFile } from './schema';
import type { LockFile } from './types';
import { openRegularFile, withFileHandle, type RegularFileIO } from '@/regular-file';

export interface StateFileIO extends RegularFileIO<string> {
  readonly writeTemporaryFile: (path: string, content: string) => Promise<void>;
  readonly rename: (source: string, destination: string) => Promise<void>;
}

export const defaultStateFileIO: StateFileIO = {
  lstat: (path) => lstat(path, { bigint: true }),
  open,
  /**
   * Создаёт новый временный lock эксклюзивно, записывает JSON и выполняет fsync. Дескриптор закрывается в
   * до выхода; существующий файл не перезаписывается. Использует open этого StateFileIO;
   * ошибки операции и close сохраняются вместе.
   */
  async writeTemporaryFile(path, content) {
    const handle = await this.open(path, 'wx', 0o600);
    await withFileHandle(handle, async () => {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    });
  },
  rename,
};

/** Read/write доступны только до завершения callback; каждый write — отдельный атомарный commit. */
export interface StateTransaction {
  /** Читает проверенный lock либо null, пока сеанс активен. */
  readonly read: () => Promise<LockFile | null>;
  /** Сохраняет lock внутри уже захваченной блокировки области. */
  readonly write: (lock: LockFile) => Promise<void>;
}

export class StateStore {
  /** Связывает пути состояния и подменяемый I/O чтения/атомарной записи; I/O не выполняет. */
  constructor(
    readonly paths: StatePaths,
    private readonly io: StateFileIO = defaultStateFileIO,
  ) {}

  /**
   * Читает lock проверенным regular-file reader и валидирует единственную текущую схему.
   *
   * @returns null только при первоначальном отсутствии корня/lock; подмена после lstat — ошибка.
   * @remarks Каталоги не создаёт, handle закрывает до выхода; ошибки чтения и close сохраняет вместе.
   */
  async read(): Promise<LockFile | null> {
    await assertScopeLocation(this.paths);
    const root = await lstat(this.paths.root).catch((cause: unknown) => {
      if (hasErrorCode(cause, 'ENOENT')) return null;
      throw cause;
    });
    if (root === null) return null;
    if (!root.isDirectory() || root.isSymbolicLink())
      throw new StateError(
        'INVALID_PATH',
        'Корневой каталог состояния должен быть обычным каталогом.',
      );
    const before = await this.io.lstat(this.paths.lockPath).catch((cause: unknown) => {
      if (hasErrorCode(cause, 'ENOENT')) return null;
      throw cause;
    });
    if (before === null) return null;
    const { handle, stats } = await openRegularFile(this.paths.lockPath, {
      expected: before,
      fileSystem: this.io,
    }).catch((cause: unknown) => {
      throw new StateError('INVALID_LOCK', 'Не удалось безопасно открыть файл состояния.', {
        cause,
      });
    });
    return withFileHandle(handle, async () => {
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (BigInt(bytes.length) !== stats.size || after.size !== stats.size)
        throw new StateError('INVALID_LOCK', 'Размер файла состояния изменился во время чтения.');
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch (cause) {
        if (cause instanceof SyntaxError)
          throw new StateError('INVALID_LOCK', 'Некорректный JSON в файле состояния.', { cause });
        throw cause;
      }
      return parseLockFile(parsed, this.paths);
    });
  }

  /**
   * Открывает read/write-сеанс под одной блокировкой области до завершения callback.
   *
   * @remarks После выхода методы сеанса недоступны. Успешные write не откатываются автоматически при
   * поздней ошибке callback; файловым откатом управляет Installer.
   */
  async transaction<T>(run: (state: StateTransaction) => Promise<T>): Promise<T> {
    return withScopeLock(this.paths, async () => {
      let active = true;
      const assertActive = () => {
        if (!active) throw new StateError('SCOPE_BUSY', 'Транзакция состояния уже завершена.');
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

  /**
   * Читает, изменяет и нормализует состояние под одной блокировкой, затем атомарно сохраняет результат.
   *
   * @returns Нормализованный lock с переносимыми путями.
   */
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

  /**
   * Самостоятельно сохраняет lock под блокировкой области.
   *
   * @remarks В уже открытой транзакции используется state.write, чтобы не захватывать блокировку
   * повторно.
   */
  async write(lock: LockFile): Promise<void> {
    return this.transaction((state) => state.write(lock));
  }

  /**
   * Проверяет схему и неизменность источников, затем сохраняет lock через временный файл и rename.
   *
   * @remarks Вызывается под блокировкой; ошибка до rename сохраняет прежний lock. При неудаче удаляет
   * временный файл; ошибка cleanup не скрывает исходную причину. Назначение до rename не удаляется.
   */
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
    try {
      await this.io.writeTemporaryFile(temporaryPath, content);
      await this.io.rename(temporaryPath, this.paths.lockPath);
    } catch (cause) {
      try {
        await unlink(temporaryPath).catch((cause: unknown) => {
          if (!hasErrorCode(cause, 'ENOENT')) throw cause;
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [cause, cleanupError],
          `Запись состояния и очистка ${temporaryPath} завершились ошибками.`,
        );
      }
      throw cause;
    }
  }
}
