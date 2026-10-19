import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { openRegularFile, preserveFileMode } from '../regular-file.ts';
import {
  assertResourceNames,
  childBufferPath,
  isBufferPathWithin,
  nativePath,
} from '../state/native-path.ts';
import { createGunzip } from 'node:zlib';
import { Header, Parser, ReadEntry } from 'tar';
import { hasErrorCode } from '../state/errors.ts';
import { hashDirectory } from '../state/hash.ts';
import { validatePathText } from '../state/paths.ts';
import { SourceError } from './errors.ts';
import {
  archiveSourceFileSystem,
  OWNED_WORKSPACE_CLEANUP,
  type ArchiveSourceFileSystem,
} from './filesystem.ts';
import { readSkillMetadata } from './frontmatter.ts';
import type { PreparedSource } from './types.ts';
import { isCancellation } from '../cancellation.ts';

export const ARCHIVE_LIMITS = Object.freeze({
  inputBytes: 20 * 1024 * 1024,
  extractedBytes: 25 * 1024 * 1024,
  entries: 1000,
});
// Ограничиваем также заголовки, PAX и padding, включая данные, пропущенные parser.
const MAX_TAR_BYTES = ARCHIVE_LIMITS.extractedBytes + 4 * 1024 * 1024;

const { isAbsolute, join, resolve } = nativePath;

export interface PrepareArchiveOptions {
  readonly cwd: string;
  /** По умолчанию переносимые имена; false допускает native POSIX-байты. */
  readonly portableNames?: boolean | undefined;
  readonly temporaryDirectory: string;
  readonly fileSystem?: ArchiveSourceFileSystem;
  readonly signal?: AbortSignal | undefined;
}

interface ArchiveEntry {
  /** Нормализованный POSIX-путь в latin1: один символ на байт, для I/O восстанавливается в Buffer. */
  readonly path: string;
  readonly directory: boolean;
  readonly mode: number;
  readonly chunks: Buffer[];
}

function invalid(message: string): never {
  throw new SourceError('INVALID_ARCHIVE', message);
}

/** Нормализует путь записи tar и отклоняет выход за корень, абсолютные пути и управляющие символы. */
function safePath(raw: Buffer, directory: boolean): string {
  // Внутренний latin1-ключ сохраняет каждый байт; для I/O компоненты восстанавливаются в Buffer.
  const path = raw.toString('latin1').replace(/\\/g, '/');
  if (
    raw.some((byte) => byte < 32 || byte === 127) ||
    path.startsWith('/') ||
    /^[a-zA-Z]:/.test(path) ||
    path.split('/').includes('..')
  )
    invalid(`Архив содержит небезопасный путь: ${JSON.stringify(raw.toString('utf8'))}.`);
  const normalized = path
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
  if (/^[a-zA-Z]:/.test(normalized))
    invalid(`Архив содержит небезопасный путь: ${JSON.stringify(raw.toString('utf8'))}.`);
  if (!normalized && !directory) invalid('Путь файла в архиве пуст.');
  return normalized;
}

/**
 * Читает ограниченный локальный архив, проверяя тип, inode и размер открытого файла. Между чтениями
 * проверяет отмену; дескриптор закрывается в finally.
 */
async function readArchive(
  path: string,
  fs: ArchiveSourceFileSystem,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const canonical = await fs.realpath(path, { encoding: 'buffer' });
  signal?.throwIfAborted();
  const expected = await fs.lstat(canonical);
  signal?.throwIfAborted();
  if (!expected.isFile())
    throw new SourceError('INVALID_SOURCE', 'Локальный архив должен быть обычным файлом.');
  const { handle: input, stats } = await openRegularFile(canonical, {
    fileSystem: fs,
    expected,
    signal,
  });
  try {
    signal?.throwIfAborted();
    if (stats.size > BigInt(ARCHIVE_LIMITS.inputBytes))
      throw new SourceError('ARCHIVE_LIMIT', 'Размер архива превышает ограничение 20 МиБ.');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      signal?.throwIfAborted();
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > ARCHIVE_LIMITS.inputBytes)
        throw new SourceError('ARCHIVE_LIMIT', 'Размер архива превышает ограничение 20 МиБ.');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (BigInt(bytes) !== stats.size) throw new Error('Размер архива изменился во время чтения.');
    return Buffer.concat(chunks, bytes);
  } finally {
    await input.close();
  }
}

/**
 * Разбирает ограниченный gzip/tar в памяти, проверяя типы записей, пути, дубликаты и полноту потока.
 * Пути записей трактуются как POSIX. Записи на диск ещё нет; при завершении закрывает gzip и снимает abort.
 */
async function unpack(
  bytes: Buffer,
  portableNames: boolean | undefined,
  signal?: AbortSignal,
): Promise<readonly ArchiveEntry[]> {
  signal?.throwIfAborted();
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) invalid('Ожидался tar-архив, сжатый gzip.');
  const entries = new Map<string, ArchiveEntry>();
  const targets = new WeakMap<ReadEntry, ArchiveEntry>();
  let rawEntryPath: Buffer = Buffer.alloc(0);
  let extendedPath: Buffer | undefined;
  let metadataType = '';
  let metadataRemaining = 0;
  let metadataChunks: Buffer[] = [];

  /** Читает NUL-terminated поле заголовка без декодирования имени. */
  function rawField(block: Buffer, start: number, length: number): Buffer {
    const field = block.subarray(start, start + length);
    const end = field.indexOf(0);
    return end < 0 ? field : field.subarray(0, end);
  }

  /** Сохраняет эффективное PAX/GNU-имя в байтах до UTF-8-декодирования библиотекой tar. */
  function finishMetadata(): void {
    const bytes = Buffer.concat(metadataChunks);
    if (metadataType === 'L') extendedPath = rawField(bytes, 0, bytes.length);
    else if (metadataType === 'x' || metadataType === 'X') {
      let offset = 0;
      while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset);
        const length = Number(bytes.subarray(offset, space).toString('ascii'));
        if (
          space < offset ||
          !Number.isSafeInteger(length) ||
          length <= space - offset + 1 ||
          offset + length > bytes.length ||
          bytes[offset + length - 1] !== 10
        )
          invalid('Некорректная PAX-запись.');
        const record = bytes.subarray(space + 1, offset + length - 1);
        if (record.subarray(0, 5).equals(Buffer.from('path=')))
          extendedPath = rawField(record, 5, record.length - 5);
        offset += length;
      }
    }
    metadataChunks = [];
  }

  /**
   * Различает заголовки и metadata-тела; обычное содержимое никогда не трактуется как имя.
   * Полное PAX/GNU-имя заменяет поля name/prefix только следующей файловой записи.
   */
  function inspectRawBlock(block: Buffer, body: boolean): void {
    if (metadataRemaining > 0) {
      const length = Math.min(metadataRemaining, block.length);
      metadataChunks.push(block.subarray(0, length));
      metadataRemaining -= length;
      if (!metadataRemaining) finishMetadata();
      return;
    }
    if (body) return;
    const header = new Header(block);
    const type = String.fromCharCode(block[156]!);
    if (['x', 'X', 'g', 'L', 'K'].includes(type)) {
      metadataType = type;
      metadataRemaining = header.size ?? 0;
      if (metadataRemaining > 1024 * 1024)
        invalid('Архив содержит слишком большие метаданные tar.');
      if (!metadataRemaining) finishMetadata();
      return;
    }
    rawEntryPath = extendedPath ?? rawField(block, 0, 100);
    if (
      extendedPath === undefined &&
      block.subarray(257, 265).equals(Buffer.from('ustar\0' + '00'))
    ) {
      const prefix = rawField(block, 345, block[475] ? 155 : 130);
      if (prefix.length) rawEntryPath = Buffer.concat([prefix, Buffer.from('/'), rawEntryPath]);
    }
    extendedPath = undefined;
  }

  let count = 0;
  let declaredBytes = 0;
  let actualBytes = 0;
  let tarBytes = 0;
  let eof = false;
  let bodyBytes = 0;
  let parseError: Error | undefined;
  let complete!: () => void;
  let fail!: (cause: unknown) => void;
  const ended = new Promise<void>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  // Ошибка parser возможна до ожидания окончательного события end.
  void ended.catch(() => {});
  const parser = new Parser({
    strict: true,
    maxMetaEntrySize: 1024 * 1024,
    /** Проверяет тип, эффективный путь и заявленный размер tar-записи до приёма её содержимого. */
    filter(_path, entry) {
      signal?.throwIfAborted();
      if (!(entry instanceof ReadEntry)) invalid('Ожидалась запись tar-архива.');
      if (!['File', 'OldFile', 'Directory'].includes(entry.type))
        invalid(`Ссылки и специальные записи в архиве не поддерживаются: ${entry.type}.`);
      if (++count > ARCHIVE_LIMITS.entries)
        throw new SourceError(
          'ARCHIVE_LIMIT',
          'Количество записей в архиве превышает ограничение 1000.',
        );
      const directory = entry.type === 'Directory';
      const path = safePath(rawEntryPath, directory);
      if (entries.has(path)) invalid(`Повторяющийся путь в архиве: ${JSON.stringify(path)}.`);
      if (!Number.isSafeInteger(entry.size) || entry.size < 0)
        invalid('Некорректный размер записи архива.');
      declaredBytes += entry.size;
      if (declaredBytes > ARCHIVE_LIMITS.extractedBytes)
        throw new SourceError(
          'ARCHIVE_LIMIT',
          'Размер распакованных файлов превышает ограничение 25 МиБ.',
        );
      const target = { path, directory, mode: (entry.mode ?? 0o644) & 0o777, chunks: [] };
      entries.set(path, target);
      targets.set(entry, target);
      bodyBytes = entry.startBlockSize;
      return true;
    },
    /** Накапливает байты проверенной записи, контролируя фактические размеры и полноту содержимого. */
    onReadEntry(entry: ReadEntry) {
      const target = targets.get(entry)!;
      let entryBytes = 0;
      entry.on('data', (chunk: Buffer) => {
        signal?.throwIfAborted();
        entryBytes += chunk.length;
        actualBytes += chunk.length;
        if (actualBytes > ARCHIVE_LIMITS.extractedBytes)
          throw new SourceError(
            'ARCHIVE_LIMIT',
            'Размер распакованных файлов превышает ограничение 25 МиБ.',
          );
        target.chunks.push(chunk);
      });
      entry.on('end', () => {
        if (entryBytes !== entry.size) invalid('Запись архива обрезана.');
      });
      entry.resume();
    },
  });
  // Неизвестный тип и избыточные метаданные должны дать ошибку, а не быть пропущены.
  parser.on('ignoredEntry', () =>
    invalid('Архив содержит неподдерживаемую запись или слишком большие метаданные.'),
  );
  parser.on('error', (error: Error) => {
    parseError = error;
    fail(error);
  });
  parser.on('eof', () => {
    eof = true;
  });
  parser.once('end', complete);
  const gzip = createGunzip();
  /** Прерывает gzip и tar при abort и сохраняет исходную причину отмены. */
  const cancel = () => {
    const reason: unknown = signal!.reason;
    fail(reason);
    gzip.destroy();
    parser.abort(
      reason instanceof Error ? reason : new Error('Распаковка отменена.', { cause: reason }),
    );
  };
  signal?.addEventListener('abort', cancel, { once: true });
  let pending: Buffer = Buffer.alloc(0);
  try {
    signal?.throwIfAborted();
    gzip.end(bytes);
    for await (const chunk of gzip) {
      signal?.throwIfAborted();
      tarBytes += chunk.length;
      if (tarBytes > MAX_TAR_BYTES)
        throw new SourceError(
          'ARCHIVE_LIMIT',
          'Превышено ограничение на метаданные и заполнение tar-архива.',
        );
      const buffer: Buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      while (buffer.length - offset >= 512) {
        signal?.throwIfAborted();
        if (eof) {
          if (buffer.subarray(offset).some((byte) => byte !== 0))
            invalid('Обнаружены неожиданные данные после завершающих блоков tar.');
          offset = buffer.length;
          break;
        }
        // Передаём заголовки отдельно, чтобы EOF не скрыл хвост в том же gzip-блоке.
        // Тела файлов остаются крупными фрагментами; PAX/GNU разбираются блоками.
        const body = bodyBytes > 0;
        const length = body
          ? Math.min(bodyBytes, Math.floor((buffer.length - offset) / 512) * 512)
          : 512;
        const block = buffer.subarray(offset, offset + length);
        inspectRawBlock(block, body);
        parser.write(block);
        signal?.throwIfAborted();
        if (body) bodyBytes -= length;
        offset += length;
        if (parseError) throw parseError;
      }
      pending = buffer.subarray(offset);
    }
    if (pending.length) invalid('Tar-архив обрезан: неполный блок.');
    parser.end();
    signal?.throwIfAborted();
    if (parseError) throw parseError;
    await ended;
    signal?.throwIfAborted();
    if (!eof || tarBytes % 512 !== 0)
      invalid('Tar-архив обрезан: отсутствуют полные завершающие блоки.');
    // Включаем неявных родителей: A/x и a/y тоже являются коллизией каталогов.
    const tree = new Map<string, Map<string, boolean>>();
    for (const entry of entries.values()) {
      signal?.throwIfAborted();
      const parts = entry.path.split('/').filter(Boolean);
      let parent = '';
      for (let index = 0; index < parts.length; index++) {
        const name = parts[index]!;
        const directory = index < parts.length - 1 || entry.directory;
        const siblings = tree.get(parent) ?? new Map<string, boolean>();
        if (siblings.has(name) && siblings.get(name) !== directory)
          invalid('Файл в архиве также используется как каталог.');
        siblings.set(name, directory);
        tree.set(parent, siblings);
        parent = parent ? parent + '/' + name : name;
      }
    }
    for (const siblings of tree.values()) {
      signal?.throwIfAborted();
      try {
        assertResourceNames(
          [...siblings.keys()].map((name) => Buffer.from(name, 'latin1')),
          portableNames,
        );
      } catch (cause) {
        throw new SourceError(
          'INVALID_ARCHIVE',
          'Архив содержит недопустимые имена или коллизии.',
          { cause },
        );
      }
    }
    return [...entries.values()];
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    if (cause instanceof SourceError) throw cause;
    throw new SourceError('INVALID_ARCHIVE', 'Некорректный или обрезанный gzip/tar-архив.', {
      cause,
    });
  } finally {
    signal?.removeEventListener('abort', cancel);
    gzip.destroy();
  }
}

/**
 * Готовит один локальный tar.gz/tgz без учёта регистра суффикса: проверяет все имена/коллизии
 * до записи, выбирает точный SKILL.md и создаёт снимок. PortableNames по умолчанию включён.
 *
 * @returns PreparedSource с хешами архива/дерева и cleanup для самостоятельного потребителя.
 * @remarks Все ресурсы создаёт внутри temporaryDirectory; при ошибке/отмене закрывает I/O и очищает
 * workspace, сохраняя ошибки очистки.
 */
export async function prepareArchive(
  source: string,
  options: PrepareArchiveOptions,
): Promise<PreparedSource> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (!isAbsolute(options.cwd) || !isAbsolute(options.temporaryDirectory))
    throw new SourceError(
      'INVALID_SOURCE',
      'Пути рабочей папки и временного каталога должны быть абсолютными.',
    );
  const identityPath = resolve(options.cwd, source);
  const fs = options.fileSystem ?? archiveSourceFileSystem;
  let workspace: string | undefined;
  try {
    validatePathText(source);
    validatePathText(options.cwd);
    validatePathText(options.temporaryDirectory);
    if (!/\.(?:tar\.gz|tgz)$/i.test(source))
      throw new SourceError(
        'INVALID_SOURCE',
        'Имя локального архива должно оканчиваться на .tar.gz или .tgz.',
      );
    const bytes = await readArchive(identityPath, fs, signal);
    const archiveHash = createHash('sha256').update(bytes).digest('hex');
    signal?.throwIfAborted();
    const entries = await unpack(bytes, options.portableNames, signal);
    const rootSkill = entries.find((entry) => entry.path === 'SKILL.md' && !entry.directory);
    let prefix = '';
    if (!rootSkill) {
      const topLevel = new Set(entries.map((entry) => entry.path.split('/')[0]).filter(Boolean));
      const outer = [...topLevel][0];
      if (
        topLevel.size !== 1 ||
        !entries.some((entry) => entry.path === `${outer}/SKILL.md` && !entry.directory)
      )
        invalid('SKILL.md должен находиться в корне архива или в единственном внешнем каталоге.');
      prefix = `${outer}/`;
    }
    await fs.realpath(options.temporaryDirectory, { encoding: 'buffer' });
    signal?.throwIfAborted();
    workspace = await fs.mkdtemp(join(options.temporaryDirectory, 'skills-installer-archive-'));
    signal?.throwIfAborted();
    const directory = join(workspace, 'skill');
    await fs.mkdir(directory, { mode: 0o755 });
    for (const entry of entries) {
      signal?.throwIfAborted();
      const path = prefix ? entry.path.slice(prefix.length) : entry.path;
      if (!path) continue;
      const target = path
        .split('/')
        .reduce<Buffer>(
          (parent, name) => childBufferPath(parent, Buffer.from(name, 'latin1')),
          Buffer.from(directory),
        );
      if (!isBufferPathWithin(Buffer.from(directory), target))
        invalid('Путь распаковки выходит за пределы временного каталога.');
      if (entry.directory) await fs.mkdir(target, { recursive: true, mode: 0o755 });
      else {
        const parent = posix.dirname(path);
        const parentTarget =
          parent === '.'
            ? Buffer.from(directory)
            : parent
                .split('/')
                .reduce<Buffer>(
                  (base, name) => childBufferPath(base, Buffer.from(name, 'latin1')),
                  Buffer.from(directory),
                );
        await fs.mkdir(parentTarget, { recursive: true, mode: 0o755 });
        signal?.throwIfAborted();
        const output = await fs.open(target, 'wx', 0o600);
        try {
          signal?.throwIfAborted();
          for (const chunk of entry.chunks) {
            signal?.throwIfAborted();
            let offset = 0;
            while (offset < chunk.length) {
              signal?.throwIfAborted();
              const { bytesWritten } = await output.write(
                chunk,
                offset,
                chunk.length - offset,
                null,
              );
              signal?.throwIfAborted();
              if (!bytesWritten)
                throw new Error('Не удалось продолжить запись распакованного файла.');
              offset += bytesWritten;
            }
          }
          await preserveFileMode(output, entry.mode);
          signal?.throwIfAborted();
        } finally {
          await output.close();
        }
      }
    }
    signal?.throwIfAborted();
    const text = await fs.readFile(join(directory, 'SKILL.md'), { encoding: 'utf8', signal });
    signal?.throwIfAborted();
    const metadata = readSkillMetadata(text);
    signal?.throwIfAborted();
    const contentHash = await hashDirectory(directory, {
      signal,
      portableNames: options.portableNames,
    });
    signal?.throwIfAborted();
    const ownedWorkspace = workspace;
    return Object.freeze({
      directory,
      ...metadata,
      identity: { kind: 'archive' as const, path: identityPath },
      version: null,
      contentHash,
      archiveHash,
      cleanup: () => fs.rm(ownedWorkspace, OWNED_WORKSPACE_CLEANUP),
    });
  } catch (cause) {
    let error: unknown = isCancellation(cause, signal)
      ? signal!.reason
      : cause instanceof SourceError
        ? cause
        : new SourceError(
            hasErrorCode(cause, 'INVALID_PATH') ? 'INVALID_SOURCE' : 'PREPARATION_FAILED',
            `Не удалось подготовить локальный архив ${JSON.stringify(identityPath)}.`,
            { cause },
          );
    if (workspace !== undefined) {
      try {
        await fs.rm(workspace, OWNED_WORKSPACE_CLEANUP);
      } catch (cleanupError) {
        error = new SourceError(
          'PREPARATION_FAILED',
          `Подготовка и удаление временных файлов завершились ошибкой: ${workspace}.`,
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
    }
    throw error;
  }
}
