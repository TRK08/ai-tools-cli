import { cp, lstat, mkdir, mkdtemp, readlink, rename, rm, rmdir, symlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { hasErrorCode } from '@/errors';
import { WORKSPACE_PREFIX } from '@/state';
import { nativePath, samePath } from '@/paths';
import { OWNED_WORKSPACE_CLEANUP } from '@/sources';

/** Подменяемый файловый I/O для проверок обрабатываемых ошибок на временных корнях. */
export const installerFileSystem = {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
};
export type InstallerFileSystem = Omit<typeof installerFileSystem, 'mkdtemp' | 'lstat'> & {
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly lstat: (path: string) => Promise<Stats>;
};

/**
 * Читает lstat без разыменования символической ссылки.
 *
 * @returns null только для ENOENT; остальные ошибки I/O пробрасываются.
 */
export async function inspectPath(path: string, fs: InstallerFileSystem) {
  return fs.lstat(path).catch((cause: unknown) => {
    if (hasErrorCode(cause, 'ENOENT')) return null;
    throw cause;
  });
}

/**
 * Проверяет обычные каталоги по нативным частям пути, отклоняя ссылки и чужие объекты.
 *
 * @param create - Создавать отсутствующие каталоги; без него проверка прекращается на первом
 * отсутствующем родителе.
 */
export async function directoryChain(
  root: string,
  parts: readonly string[],
  fs: InstallerFileSystem,
  create = false,
): Promise<void> {
  let path = root;
  for (const part of parts) {
    path = nativePath.join(path, part);
    if (create) {
      await fs.mkdir(path).catch((cause: unknown) => {
        if (!hasErrorCode(cause, 'EEXIST')) throw cause;
      });
    }
    const stats = await inspectPath(path, fs);
    if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) {
      throw new Error(
        `Ожидался обычный каталог; обнаружена ссылка или чужой объект по пути: ${path}.`,
      );
    }
    if (!stats) return;
  }
}

/** Workspace и backups находятся на одной файловой системе; при неудачном откате recovery сохраняется. */
export class FileTransaction {
  private readonly undo: (() => Promise<void>)[] = [];

  private constructor(
    readonly workspace: string,
    private readonly fs: InstallerFileSystem,
  ) {}

  /**
   * Создаёт workspace и выполняет callback с журналом обратных файловых операций.
   *
   * @remarks Успешный возврат callback означает завершённый commit. Ошибка callback запускает откат;
   * ошибка очистки после commit его не запускает. При неудачном откате workspace сохраняется для
   * восстановления.
   */
  static async run<T>(
    workspaceParent: string,
    fs: InstallerFileSystem,
    run: (files: FileTransaction) => Promise<T>,
  ): Promise<T> {
    const files = new FileTransaction(
      await fs.mkdtemp(nativePath.join(workspaceParent, WORKSPACE_PREFIX)),
      fs,
    );
    let result: T;
    try {
      result = await run(files);
    } catch (cause) {
      const errors: unknown[] = [];
      for (const undo of files.undo.reverse()) {
        try {
          await undo();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new Error(
          `Операция и откат завершились ошибкой; файлы для восстановления сохранены в ${files.workspace}.`,
          {
            cause: new AggregateError([cause, ...errors]),
          },
        );
      }
      await fs.rm(files.workspace, OWNED_WORKSPACE_CLEANUP).catch((cleanupError: unknown) => {
        throw new Error(
          `Операция отменена откатом, но удалить временный каталог не удалось: ${files.workspace}.`,
          {
            cause: new AggregateError([cause, cleanupError]),
          },
        );
      });
      throw cause;
    }
    // Lock уже сохранён: сбой очистки не должен откатывать файлы к прежнему состоянию.
    await fs.rm(files.workspace, OWNED_WORKSPACE_CLEANUP).catch((cause: unknown) => {
      throw new Error(
        `Операция завершена, но удалить временный каталог не удалось: ${files.workspace}.`,
        {
          cause,
        },
      );
    });
    return result;
  }

  /**
   * Переименовывает объект и регистрирует обратный rename для отката. Ошибка EXDEV пробрасывается без
   * замены через копирование.
   */
  async move(source: string, destination: string): Promise<void> {
    await this.fs.rename(source, destination);
    this.undo.push(() => this.fs.rename(destination, source));
  }

  /** Копирует снимок в собственный staging без разыменования ссылок; очисткой владеет транзакция. */
  async stageCopy(source: string, name: string): Promise<string> {
    const destination = nativePath.join(this.workspace, `staging-${name}`);
    await this.fs.cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    return destination;
  }

  /** Создаёт symlink POSIX или junction Windows с абсолютной целью; откат снимает только ссылку. */
  async link(target: string, destination: string): Promise<void> {
    await this.fs.symlink(target, destination, nativePath.sep === '\\' ? 'junction' : 'dir');
    this.undo.push(() => this.fs.rm(destination));
  }

  /** Снимает только объект ссылки без rename между томами; откат восстанавливает исходный target. */
  async unlink(path: string, expectedTarget: string): Promise<void> {
    const target = await this.fs.readlink(path);
    if (!samePath(nativePath.resolve(nativePath.dirname(path), target), expectedTarget))
      throw new Error(`Цель ссылки изменилась перед удалением: ${path}.`);
    await this.fs.rm(path);
    this.undo.push(() =>
      this.fs.symlink(target, path, nativePath.sep === '\\' ? 'junction' : 'dir'),
    );
  }
}
