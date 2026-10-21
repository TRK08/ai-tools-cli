import { createHash } from 'node:crypto';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { openRegularFile, withFileHandle } from '../regular-file.ts';
import { StateError } from './errors.ts';
import { assertResourceNames, childBufferPath, nativePath } from './native-path.ts';

export interface HashDirectoryOptions {
  readonly signal?: AbortSignal | undefined;
  /** По умолчанию переносимые NFC-имена; false сохраняет native POSIX bytes. */
  readonly portableNames?: boolean | undefined;
  readonly fileSystem?: {
    readonly lstat: typeof lstat;
    readonly open: typeof open;
    readonly readdir: typeof readdir;
    readonly readlink: typeof readlink;
  };
}

/**
 * Вычисляет SHA-256 типов, логических путей с / и точных bytes; права и пустые поддеревья игнорирует.
 *
 * @remarks Поля предваряются восьмибайтовой длиной big-endian; корень каталога имеет пустой путь.
 * Portable-имена проверяются на коллизии и хешируются в NFC, физические имена не переписываются.
 * Native POSIX сохраняет байтовые имена; ссылка включает target без чтения цели. Файлы читаются
 * проверенным reader блоками; отмена проверяется между I/O, handle закрывается до выхода.
 */
export async function hashDirectory(
  directory: string,
  options: HashDirectoryOptions = {},
): Promise<string> {
  const { signal, portableNames = true } = options;
  const fs = options.fileSystem ?? { lstat, open, readdir, readlink };
  signal?.throwIfAborted();
  if (!nativePath.isAbsolute(directory)) {
    throw new StateError(
      'INVALID_PATH',
      'Корневой путь для вычисления хеша должен быть абсолютным.',
    );
  }
  const hash = createHash('sha256');
  const directories: { path: Buffer; emitted: boolean }[] = [];

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

  /** Добавляет предков перед первым листом; ветви только из каталогов не попадают в хеш. */
  function emitDirectories(): void {
    for (const directory of directories) {
      if (!directory.emitted) {
        field(directory.path);
        text('directory');
        directory.emitted = true;
      }
    }
  }

  /** Обходит нативный путь отдельно от логического; файлы проверяются по точным identity и размеру. */
  async function visit(absolutePath: Buffer, relativePath: Buffer): Promise<void> {
    signal?.throwIfAborted();
    const stats = await fs.lstat(absolutePath, { bigint: true });
    signal?.throwIfAborted();

    if (stats.isDirectory()) {
      directories.push({ path: relativePath, emitted: false });
      if (relativePath.length === 0) emitDirectories();
      const names = await fs.readdir(absolutePath, { encoding: 'buffer' });
      signal?.throwIfAborted();
      assertResourceNames(names, portableNames);
      const entries = names.map((name) => ({
        name,
        logical: portableNames ? Buffer.from(name.toString('utf8').normalize('NFC')) : name,
      }));
      entries.sort((a, b) => Buffer.compare(a.logical, b.logical));
      for (const { name, logical } of entries) {
        const relative = relativePath.length
          ? Buffer.concat([relativePath, Buffer.from('/'), logical])
          : logical;
        await visit(childBufferPath(absolutePath, name), relative);
      }
      directories.pop();
      return;
    }

    emitDirectories();
    field(relativePath);
    if (stats.isSymbolicLink()) {
      text('symlink');
      field(await fs.readlink(absolutePath, { encoding: 'buffer' }));
      signal?.throwIfAborted();
      return;
    }

    if (stats.isFile()) {
      const { handle, stats: opened } = await openRegularFile(absolutePath, {
        expected: stats,
        signal,
        fileSystem: { lstat: (path) => fs.lstat(path, { bigint: true }), open: fs.open },
      });
      await withFileHandle(handle, async () => {
        text('file');
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
        const final = await handle.stat({ bigint: true });
        signal?.throwIfAborted();
        if (
          !final.isFile() ||
          final.dev !== opened.dev ||
          final.ino !== opened.ino ||
          total !== opened.size ||
          final.size !== opened.size
        ) {
          throw new Error(
            `Размер файла изменился во время вычисления хеша: ${absolutePath.toString()}`,
          );
        }
      });
      return;
    }

    throw new Error(
      `Неподдерживаемый объект файловой системы при вычислении хеша: ${absolutePath.toString()}`,
    );
  }

  text('skills-installer-content-v1');
  await visit(Buffer.from(nativePath.resolve(directory)), Buffer.alloc(0));
  signal?.throwIfAborted();
  return hash.digest('hex');
}
