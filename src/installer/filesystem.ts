import { lstat, mkdir, mkdtemp, readlink, rename, rm, rmdir, symlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { hasErrorCode } from '../state/errors.ts';
import { WORKSPACE_PREFIX } from '../state/paths.ts';

/** Mutation seam for testing handled filesystem failures without touching real agents. */
export const installerFileSystem = { lstat, mkdir, mkdtemp, readlink, rename, rm, rmdir, symlink };
export type InstallerFileSystem = Omit<typeof installerFileSystem, 'mkdtemp' | 'lstat'> & {
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly lstat: (path: string) => Promise<Stats>;
};

export async function inspectPath(path: string, fs: InstallerFileSystem) {
  return fs.lstat(path).catch((cause: unknown) => {
    if (hasErrorCode(cause, 'ENOENT')) return null;
    throw cause;
  });
}

/** Check every owned parent, so mkdir/rename never traverse a redirected agent or state root. */
export async function directoryChain(
  root: string,
  parts: readonly string[],
  fs: InstallerFileSystem,
  create = false,
): Promise<void> {
  let path = root;
  for (const part of parts) {
    path = join(path, part);
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

/** Backups live on the same filesystem; recovery data survives a failed rollback. */
export class FileTransaction {
  private readonly undo: (() => Promise<void>)[] = [];

  private constructor(
    readonly workspace: string,
    private readonly fs: InstallerFileSystem,
  ) {}

  static async run<T>(
    workspaceParent: string,
    fs: InstallerFileSystem,
    run: (files: FileTransaction) => Promise<T>,
  ): Promise<T> {
    const files = new FileTransaction(
      await fs.mkdtemp(join(workspaceParent, WORKSPACE_PREFIX)),
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
      await fs
        .rm(files.workspace, { recursive: true, force: true })
        .catch((cleanupError: unknown) => {
          throw new Error(
            `Операция отменена откатом, но удалить временный каталог не удалось: ${files.workspace}.`,
            {
              cause: new AggregateError([cause, cleanupError]),
            },
          );
        });
      throw cause;
    }
    // The state commit succeeded. A cleanup failure must never roll files back against the new lock.
    await fs.rm(files.workspace, { recursive: true, force: true }).catch((cause: unknown) => {
      throw new Error(
        `Операция завершена, но удалить временный каталог не удалось: ${files.workspace}.`,
        {
          cause,
        },
      );
    });
    return result;
  }

  async move(source: string, destination: string): Promise<void> {
    await this.fs.rename(source, destination);
    this.undo.push(() => this.fs.rename(destination, source));
  }

  async link(target: string, destination: string): Promise<void> {
    await this.fs.symlink(target, destination);
    this.undo.push(() => this.fs.rm(destination));
  }
}
