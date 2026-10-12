import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hasErrorCode } from '../state/errors.ts';
import { WORKSPACE_PREFIX } from '../state/paths.ts';

/** Mutation seam for testing handled filesystem failures without touching real agents. */
export const installerFileSystem = { lstat, mkdir, mkdtemp, rename, rm };
export type InstallerFileSystem = Omit<typeof installerFileSystem, 'mkdtemp'> & {
  readonly mkdtemp: (prefix: string) => Promise<string>;
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
        `Expected a regular directory; refusing redirected or foreign path: ${path}.`,
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
          `Operation and rollback failed; recovery files remain at ${files.workspace}.`,
          {
            cause: new AggregateError([cause, ...errors]),
          },
        );
      }
      await fs
        .rm(files.workspace, { recursive: true, force: true })
        .catch((cleanupError: unknown) => {
          throw new Error(
            `Operation rolled back, but workspace cleanup failed: ${files.workspace}.`,
            {
              cause: new AggregateError([cause, cleanupError]),
            },
          );
        });
      throw cause;
    }
    // The state commit succeeded. A cleanup failure must never roll files back against the new lock.
    await fs.rm(files.workspace, { recursive: true, force: true }).catch((cause: unknown) => {
      throw new Error(`Operation committed, but workspace cleanup failed: ${files.workspace}.`, {
        cause,
      });
    });
    return result;
  }

  async move(source: string, destination: string): Promise<void> {
    await this.fs.rename(source, destination);
    this.undo.push(() => this.fs.rename(destination, source));
  }
}
