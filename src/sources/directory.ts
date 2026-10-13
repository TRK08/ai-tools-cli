import { constants, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { hasErrorCode } from '../state/errors.ts';
import { hashDirectory } from '../state/hash.ts';
import { validatePathText } from '../state/paths.ts';
import { INSTALLER_LOCK_NAME, LOCK_TEMP_PREFIX, WORKSPACE_PREFIX } from '../state/paths.ts';
import { SourceError } from './errors.ts';
import { directorySourceFileSystem, type DirectorySourceFileSystem } from './filesystem.ts';
import { readSkillMetadata } from './frontmatter.ts';
import type { PreparedSource } from './types.ts';
import { isCancellation } from '../cancellation.ts';

export interface PrepareDirectoryOptions {
  readonly cwd: string;
  /** Существующая временная база вызывающего кода; не определяется через process.env. */
  readonly temporaryDirectory: string;
  /** Дополнительные файлы и корни каталогов CLI, например глобальное состояние. */
  readonly excludedPaths?: readonly string[];
  /** Абсолютные префиксы временных каталогов операций и файлов атомарной записи lock. */
  readonly excludedPrefixes?: readonly string[];
  readonly fileSystem?: DirectorySourceFileSystem;
  readonly signal?: AbortSignal | undefined;
}

const separator = Buffer.from('/');

function childPath(parent: Buffer, name: Buffer): Buffer {
  return Buffer.concat([parent, separator, name]);
}

function within(root: Buffer, path: Buffer): boolean {
  const prefix = root[root.length - 1] === 47 ? root : Buffer.concat([root, separator]);
  return path.equals(root) || path.subarray(0, prefix.length).equals(prefix);
}

/**
 * Копирует файл блоками, проверяя inode и размер, затем сохраняет его права. Между I/O проверяет отмену;
 * оба дескриптора закрываются до завершения операции.
 */
async function copyFile(
  source: Buffer,
  destination: Buffer,
  expected: BigIntStats,
  fs: DirectorySourceFileSystem,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const input = await fs.open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    signal?.throwIfAborted();
    const opened = await input.stat({ bigint: true });
    signal?.throwIfAborted();
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error(`Объект источника изменился во время копирования: ${source.toString()}`);
    }
    const output = await fs.open(destination, 'wx', 0o600);
    try {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(64 * 1024);
      let total = 0n;
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        signal?.throwIfAborted();
        if (bytesRead === 0) break;
        total += BigInt(bytesRead);
        if (total > opened.size)
          throw new Error('Размер исходного файла изменился во время копирования.');
        let offset = 0;
        while (offset < bytesRead) {
          signal?.throwIfAborted();
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
          signal?.throwIfAborted();
          if (bytesWritten === 0)
            throw new Error('Не удалось продолжить запись подготовленного содержимого.');
          offset += bytesWritten;
        }
      }
      if (total !== opened.size)
        throw new Error('Размер исходного файла изменился во время копирования.');
      await output.chmod(Number(opened.mode & 0o777n));
      signal?.throwIfAborted();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/**
 * Создаёт снимок локального скилла с разыменованными ссылками и исходными байтами/правами файлов.
 * Исключает состояние CLI и временные ресурсы, отклоняет циклы и специальные объекты.
 *
 * @returns PreparedSource внутри temporaryDirectory; самостоятельный потребитель обязан вызвать cleanup.
 * @remarks При ошибке/отмене очищает собственный workspace; сбой очистки сохраняется вместе с исходной
 * причиной.
 */
export async function prepareDirectory(
  source: string,
  options: PrepareDirectoryOptions,
): Promise<PreparedSource> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (
    !isAbsolute(options.cwd) ||
    !isAbsolute(options.temporaryDirectory) ||
    [...(options.excludedPaths ?? []), ...(options.excludedPrefixes ?? [])].some(
      (path) => !isAbsolute(path),
    )
  ) {
    throw new SourceError(
      'INVALID_SOURCE',
      'Пути рабочей папки и временного каталога должны быть абсолютными.',
    );
  }
  const identityPath = resolve(options.cwd, source);
  const fs = options.fileSystem ?? directorySourceFileSystem;
  let workspace: string | undefined;

  try {
    validatePathText(source);
    validatePathText(options.cwd);
    validatePathText(options.temporaryDirectory);
    const excluded: Buffer[] = [];
    for (const path of [
      join(options.cwd, '.agents', 'skills'),
      join(options.cwd, INSTALLER_LOCK_NAME),
      join(options.cwd, '.skills-installer-operation.lock'),
      ...(options.excludedPaths ?? []),
    ]) {
      signal?.throwIfAborted();
      validatePathText(path);
      const lexical = Buffer.from(resolve(path));
      excluded.push(lexical);
      try {
        excluded.push(await fs.realpath(lexical));
      } catch (cause) {
        // Недоступный исключённый корень не имеет достижимой цели; сохраняем лексический путь.
        if (!['ENOENT', 'ENOTDIR', 'ELOOP'].some((code) => hasErrorCode(cause, code))) throw cause;
      }
    }
    const prefixes: Buffer[] = [];
    for (const prefix of [
      join(options.cwd, '.agents', WORKSPACE_PREFIX),
      join(options.cwd, LOCK_TEMP_PREFIX),
      ...(options.excludedPrefixes ?? []),
    ]) {
      signal?.throwIfAborted();
      validatePathText(prefix);
      prefixes.push(Buffer.from(prefix));
      try {
        prefixes.push(
          Buffer.from(
            join((await fs.realpath(Buffer.from(dirname(prefix)))).toString(), basename(prefix)),
          ),
        );
      } catch (cause) {
        if (!['ENOENT', 'ENOTDIR', 'ELOOP'].some((code) => hasErrorCode(cause, code))) throw cause;
      }
    }
    /** Исключает служебные корни целиком и зарезервированные префиксы временных путей CLI. */
    const isExcluded = (path: Buffer) =>
      excluded.some((root) => within(root, path)) ||
      prefixes.some((prefix) => path.subarray(0, prefix.length).equals(prefix));
    const sourceRoot = await fs.realpath(Buffer.from(identityPath));
    signal?.throwIfAborted();
    const rootStats = await fs.lstat(sourceRoot);
    signal?.throwIfAborted();
    if (!rootStats.isDirectory()) {
      throw new SourceError('INVALID_SOURCE', 'Локальный источник должен быть каталогом.');
    }
    if (isExcluded(sourceRoot) || isExcluded(Buffer.from(identityPath))) {
      throw new SourceError(
        'INVALID_SOURCE',
        'Состояние CLI нельзя использовать как локальный источник.',
      );
    }
    // Проверяем наличие SKILL.md до временных файлов; ссылки проверяет обход дерева.
    await fs.lstat(childPath(sourceRoot, Buffer.from('SKILL.md')));
    signal?.throwIfAborted();
    const temporaryRoot = await fs.realpath(Buffer.from(resolve(options.temporaryDirectory)));
    signal?.throwIfAborted();
    if (within(temporaryRoot, sourceRoot)) {
      throw new SourceError(
        'INVALID_SOURCE',
        'Локальный источник не может находиться внутри временного каталога CLI.',
      );
    }
    workspace = await fs.mkdtemp(join(temporaryRoot.toString(), 'skills-installer-source-'));
    signal?.throwIfAborted();
    const directory = join(workspace, 'skill');
    const destinationRoot = Buffer.from(directory);

    /**
     * Обходит дерево с разыменованием ссылок, исключениями и проверкой циклов по inode. Создаёт объекты
     * только внутри destinationRoot и проверяет отмену между I/O.
     */
    async function visit(
      path: Buffer,
      destination: Buffer,
      ancestors: ReadonlySet<string>,
    ): Promise<void> {
      signal?.throwIfAborted();
      if (!within(destinationRoot, destination)) {
        throw new SourceError(
          'INVALID_SOURCE',
          'Путь копирования выходит за пределы подготовленного каталога.',
        );
      }
      if (isExcluded(path) || within(temporaryRoot, path)) return;
      const canonical = await fs.realpath(path);
      signal?.throwIfAborted();
      if (isExcluded(canonical) || within(temporaryRoot, canonical)) return;
      const stats = await fs.lstat(canonical);
      signal?.throwIfAborted();
      if (stats.isDirectory()) {
        const key = `${stats.dev}:${stats.ino}`;
        if (ancestors.has(key)) {
          throw new SourceError(
            'SOURCE_CYCLE',
            `Цикл ссылок на каталоги по пути ${path.toString()}.`,
          );
        }
        await fs.mkdir(destination, { mode: 0o755 });
        signal?.throwIfAborted();
        const nextAncestors = new Set(ancestors).add(key);
        const names = await fs.readdir(canonical);
        signal?.throwIfAborted();
        names.sort(Buffer.compare);
        for (const name of names) {
          if (
            name.length === 0 ||
            name.equals(Buffer.from('.')) ||
            name.equals(Buffer.from('..')) ||
            name.includes(0) ||
            name.includes(separator)
          ) {
            throw new SourceError('INVALID_SOURCE', 'Некорректное имя объекта в каталоге.');
          }
          await visit(childPath(canonical, name), childPath(destination, name), nextAncestors);
        }
      } else if (stats.isFile()) {
        await copyFile(canonical, destination, stats, fs, signal);
      } else {
        throw new SourceError(
          'UNSUPPORTED_ENTRY',
          `Неподдерживаемый объект источника: ${path.toString()}.`,
        );
      }
    }

    await visit(sourceRoot, destinationRoot, new Set());
    signal?.throwIfAborted();
    const text = await fs.readFile(join(directory, 'SKILL.md'), { encoding: 'utf8', signal });
    signal?.throwIfAborted();
    const metadata = readSkillMetadata(text);
    signal?.throwIfAborted();
    const contentHash = await hashDirectory(directory, { signal });
    signal?.throwIfAborted();
    const ownedWorkspace = workspace;
    return Object.freeze({
      directory,
      ...metadata,
      identity: { kind: 'directory' as const, path: identityPath },
      version: null,
      contentHash,
      cleanup: () => fs.rm(ownedWorkspace, { recursive: true, force: true }),
    });
  } catch (cause) {
    let error: unknown = isCancellation(cause, signal)
      ? signal!.reason
      : cause instanceof SourceError
        ? cause
        : new SourceError(
            hasErrorCode(cause, 'ELOOP')
              ? 'SOURCE_CYCLE'
              : hasErrorCode(cause, 'INVALID_PATH')
                ? 'INVALID_SOURCE'
                : 'PREPARATION_FAILED',
            `Не удалось подготовить локальный источник ${JSON.stringify(identityPath)}.`,
            { cause },
          );
    if (workspace !== undefined) {
      try {
        await fs.rm(workspace, { recursive: true, force: true });
      } catch (cleanupError) {
        error = new SourceError(
          'PREPARATION_FAILED',
          `Подготовка и удаление временных файлов завершились ошибкой: ${workspace}.`,
          {
            cause: new AggregateError([error, cleanupError]),
          },
        );
      }
    }
    throw error;
  }
}
