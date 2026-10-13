import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { StateError } from './errors.ts';

/**
 * Hash the tree itself, including unexpected links without following their targets.
 * Fields use an eight-byte big-endian length followed by their unmodified bytes.
 * The entry type determines its remaining fields: file = executable + contents;
 * symlink = target; directory = recursively sorted entries. The root path is empty.
 */
export async function hashDirectory(directory: string): Promise<string> {
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

  async function visit(absolutePath: Buffer, relativePath: Buffer): Promise<void> {
    const stats = await lstat(absolutePath, { bigint: true });
    field(relativePath);

    if (stats.isSymbolicLink()) {
      text('symlink');
      field(await readlink(absolutePath, { encoding: 'buffer' }));
      return;
    }

    if (stats.isDirectory()) {
      text('directory');
      const names = await readdir(absolutePath, { encoding: 'buffer' });
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
      // NOFOLLOW rejects a link replacing this file between lstat and open.
      // NONBLOCK also prevents a replacement FIFO from blocking open indefinitely.
      const handle = await open(
        absolutePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );

      try {
        const opened = await handle.stat({ bigint: true });
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
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
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
  return hash.digest('hex');
}
