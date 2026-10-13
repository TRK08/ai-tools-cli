import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { StateError } from './errors.ts';

export interface HashDirectoryOptions {
  readonly signal?: AbortSignal | undefined;
  readonly fileSystem?: {
    readonly lstat: typeof lstat;
    readonly open: typeof open;
    readonly readdir: typeof readdir;
    readonly readlink: typeof readlink;
  };
}

/**
 * Вычисляет детерминированный SHA-256 дерева по байтовым путям, типам, содержимому и признаку executable.
 *
 * @remarks Поля предваряются восьмибайтовой длиной big-endian. Файл содержит executable и байты; ссылка —
 * цель без разыменования; каталог — отсортированные по байтам записи. Путь корня пуст; абсолютный корень,
 * mtime и владелец не учитываются. Отмена проверяется между I/O, дескрипторы закрываются в finally.
 */
export async function hashDirectory(
  directory: string,
  options: HashDirectoryOptions = {},
): Promise<string> {
  const { signal } = options;
  const fs = options.fileSystem ?? { lstat, open, readdir, readlink };
  signal?.throwIfAborted();
  if (!isAbsolute(directory)) {
    throw new StateError(
      'INVALID_PATH',
      'Корневой путь для вычисления хеша должен быть абсолютным.',
    );
  }
  const hash = createHash('sha256');

  function fieldLength(size: bigint): void {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(size);
    hash.update(length);
  }

  function field(bytes: Uint8Array): void {
    fieldLength(BigInt(bytes.byteLength));
    hash.update(bytes);
  }

  function text(value: string): void {
    field(Buffer.from(value));
  }

  /**
   * Добавляет узел дерева в хеш, не разыменовывая ссылки; для файла проверяет inode/размер и читает
   * блоками.
   */
  async function visit(absolutePath: Buffer, relativePath: Buffer): Promise<void> {
    signal?.throwIfAborted();
    const stats = await fs.lstat(absolutePath, { bigint: true });
    signal?.throwIfAborted();
    field(relativePath);

    if (stats.isSymbolicLink()) {
      text('symlink');
      field(await fs.readlink(absolutePath, { encoding: 'buffer' }));
      signal?.throwIfAborted();
      return;
    }

    if (stats.isDirectory()) {
      text('directory');
      const names = await fs.readdir(absolutePath, { encoding: 'buffer' });
      signal?.throwIfAborted();
      names.sort(Buffer.compare);

      for (const name of names) {
        const childPath = Buffer.concat([absolutePath, Buffer.from('/'), name]);
        const childRelativePath =
          relativePath.byteLength === 0
            ? name
            : Buffer.concat([relativePath, Buffer.from('/'), name]);
        await visit(childPath, childRelativePath);
      }
      return;
    }

    if (stats.isFile()) {
      // NOFOLLOW отклоняет ссылку, подменившую файл между lstat и open.
      // NONBLOCK не позволяет подменённому FIFO заблокировать open навсегда.
      const handle = await fs.open(
        absolutePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );

      try {
        signal?.throwIfAborted();
        const opened = await handle.stat({ bigint: true });
        signal?.throwIfAborted();
        if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino) {
          throw new Error(
            `Объект файловой системы изменился во время вычисления хеша: ${absolutePath.toString()}`,
          );
        }

        text('file');
        field(Buffer.from([(opened.mode & 0o111n) === 0n ? 0 : 1]));
        fieldLength(opened.size);
        const buffer = Buffer.alloc(64 * 1024);
        let total = 0n;
        for (;;) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          signal?.throwIfAborted();
          if (bytesRead === 0) break;
          total += BigInt(bytesRead);
          if (total > opened.size) break;
          hash.update(buffer.subarray(0, bytesRead));
        }
        if (total !== opened.size) {
          throw new Error(
            `Размер файла изменился во время вычисления хеша: ${absolutePath.toString()}`,
          );
        }
      } finally {
        await handle.close();
      }
      return;
    }

    throw new Error(
      `Неподдерживаемый объект файловой системы при вычислении хеша: ${absolutePath.toString()}`,
    );
  }

  text('skills-installer-content-v1');
  await visit(Buffer.from(resolve(directory)), Buffer.alloc(0));
  signal?.throwIfAborted();
  return hash.digest('hex');
}
