import type { BigIntStats } from 'node:fs';
import { openRegularFile, preserveFileMode, withFileHandle, writeAll } from '../regular-file.ts';
import {
  assertResourceNames,
  childBufferPath as childPath,
  hasBufferPathPrefix,
  isBufferPathWithin as within,
  nativePath,
} from '../state/native-path.ts';
import { hasErrorCode } from '../state/errors.ts';
import { hashDirectory } from '../state/hash.ts';
import { validatePathText } from '../state/paths.ts';
import { INSTALLER_LOCK_NAME, LOCK_TEMP_PREFIX, WORKSPACE_PREFIX } from '../state/paths.ts';
import { SourceError } from './errors.ts';
import {
  directorySourceFileSystem,
  cleanupFailedPreparation,
  OWNED_WORKSPACE_CLEANUP,
  type DirectorySourceFileSystem,
} from './filesystem.ts';
import { readSkillMetadata } from './frontmatter.ts';
import type { PreparedSource } from './types.ts';
import { isCancellation } from '../cancellation.ts';

export interface PrepareDirectoryOptions {
  readonly cwd: string;
  /** Проверка всех ресурсов на переносимость; false сохраняет native POSIX-имена. Windows всегда строгий. */
  readonly portableNames?: boolean | undefined;
  /** Существующая временная база вызывающего кода; не определяется через process.env. */
  readonly temporaryDirectory: string;
  /** Дополнительные файлы и корни каталогов CLI, например глобальное состояние. */
  readonly excludedPaths?: readonly string[];
  /** Абсолютные префиксы временных каталогов операций и файлов атомарной записи lock. */
  readonly excludedPrefixes?: readonly string[];
  readonly fileSystem?: DirectorySourceFileSystem;
  readonly signal?: AbortSignal | undefined;
}

const { basename, dirname, isAbsolute, join, resolve } = nativePath;

/**
 * Копирует файл блоками, проверяя identity и размер, затем сохраняет POSIX-права. Между I/O проверяет отмену;
 * закрывает сначала выходной, затем входной handle, сохраняя ошибки операции и обоих закрытий.
 */
async function copyFile(
  source: Buffer,
  destination: Buffer,
  expected: BigIntStats,
  fs: DirectorySourceFileSystem,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const { handle: input, stats: opened } = await openRegularFile(source, {
    fileSystem: fs,
    expected,
    signal,
  });
  await withFileHandle(input, async () => {
    signal?.throwIfAborted();
    const output = await fs.open(destination, 'wx', 0o600);
    await withFileHandle(output, async () => {
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
        await writeAll(
          output,
          buffer.subarray(0, bytesRead),
          'Не удалось продолжить запись подготовленного содержимого.',
          signal,
        );
      }
      if (total !== opened.size)
        throw new Error('Размер исходного файла изменился во время копирования.');
      await preserveFileMode(output, Number(opened.mode & 0o777n));
      signal?.throwIfAborted();
    });
  });
}

/**
 * Создаёт снимок локального скилла с разыменованными ссылками и исходными байтами/правами файлов.
 * Исключает состояние CLI и временные ресурсы, проверяет имена до копирования детей,
 * отклоняет циклы и специальные объекты. PortableNames по умолчанию включён.
 *
 * @returns PreparedSource внутри temporaryDirectory; самостоятельный потребитель обязан вызвать cleanup.
 * @remarks При ошибке/отмене закрывает handles и очищает собственный workspace; ошибки закрытия
 * и очистки сохраняются вместе с исходной причиной.
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
    for (const path of new Set([
      join(options.cwd, '.agents', 'skills'),
      join(options.cwd, INSTALLER_LOCK_NAME),
      join(options.cwd, '.skills-installer-operation.lock'),
      ...(options.excludedPaths ?? []),
    ])) {
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
    for (const prefix of new Set([
      join(options.cwd, '.agents', WORKSPACE_PREFIX),
      join(options.cwd, LOCK_TEMP_PREFIX),
      ...(options.excludedPrefixes ?? []),
    ])) {
      signal?.throwIfAborted();
      validatePathText(prefix);
      prefixes.push(Buffer.from(prefix));
      try {
        prefixes.push(
          childPath(await fs.realpath(Buffer.from(dirname(prefix))), Buffer.from(basename(prefix))),
        );
      } catch (cause) {
        if (!['ENOENT', 'ENOTDIR', 'ELOOP'].some((code) => hasErrorCode(cause, code))) throw cause;
      }
    }
    /** Исключает служебные корни целиком и зарезервированные префиксы временных путей CLI. */
    const isExcluded = (path: Buffer) =>
      excluded.some((root) => within(root, path)) ||
      prefixes.some((prefix) => hasBufferPathPrefix(path, prefix));
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
    // Проверяем точное имя до временных файлов, независимо от чувствительности ФС к регистру.
    const rootNames = await fs.readdir(sourceRoot);
    signal?.throwIfAborted();
    assertResourceNames(rootNames, options.portableNames);
    if (!rootNames.some((name) => name.equals(Buffer.from('SKILL.md')))) {
      throw new SourceError('INVALID_SOURCE', 'В корне требуется точное имя SKILL.md.');
    }
    signal?.throwIfAborted();
    const temporaryRoot = await fs.realpath(Buffer.from(resolve(options.temporaryDirectory)));
    signal?.throwIfAborted();
    if (within(temporaryRoot, sourceRoot)) {
      throw new SourceError(
        'INVALID_SOURCE',
        'Локальный источник не может находиться внутри временного каталога CLI.',
      );
    }
    workspace = await fs.mkdtemp(join(options.temporaryDirectory, 'skills-installer-source-'));
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
        const nextAncestors = new Set(ancestors).add(key);
        const names = await fs.readdir(canonical);
        signal?.throwIfAborted();
        assertResourceNames(names, options.portableNames);
        if (
          destination.equals(destinationRoot) &&
          !names.some((name) => name.equals(Buffer.from('SKILL.md')))
        ) {
          throw new SourceError('INVALID_SOURCE', 'В корне требуется точное имя SKILL.md.');
        }
        await fs.mkdir(destination, { mode: 0o755 });
        signal?.throwIfAborted();
        names.sort(Buffer.compare);
        for (const name of names) {
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
    const contentHash = await hashDirectory(directory, {
      signal,
      portableNames: options.portableNames,
    });
    signal?.throwIfAborted();
    const ownedWorkspace = workspace;
    return Object.freeze({
      directory,
      ...metadata,
      identity: { kind: 'directory' as const, path: identityPath },
      version: null,
      contentHash,
      cleanup: () => fs.rm(ownedWorkspace, OWNED_WORKSPACE_CLEANUP),
    });
  } catch (cause) {
    const error: unknown = isCancellation(cause, signal)
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
    return cleanupFailedPreparation(
      workspace,
      error,
      fs,
      (cause) =>
        new SourceError(
          'PREPARATION_FAILED',
          `Подготовка и удаление временных файлов завершились ошибкой: ${workspace}.`,
          { cause },
        ),
    );
  }
}
