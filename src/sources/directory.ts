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

export interface PrepareDirectoryOptions {
  readonly cwd: string;
  /** Existing dedicated temporary base supplied by the caller, never taken from process.env. */
  readonly temporaryDirectory: string;
  /** Additional CLI files or directory roots, e.g. global state. */
  readonly excludedPaths?: readonly string[];
  /** Absolute pathname prefixes reserved for unique operation directories and lock temp files. */
  readonly excludedPrefixes?: readonly string[];
  readonly fileSystem?: DirectorySourceFileSystem;
}

const separator = Buffer.from('/');

function childPath(parent: Buffer, name: Buffer): Buffer {
  return Buffer.concat([parent, separator, name]);
}

function within(root: Buffer, path: Buffer): boolean {
  const prefix = root[root.length - 1] === 47 ? root : Buffer.concat([root, separator]);
  return path.equals(root) || path.subarray(0, prefix.length).equals(prefix);
}

async function copyFile(
  source: Buffer,
  destination: Buffer,
  expected: BigIntStats,
  fs: DirectorySourceFileSystem,
): Promise<void> {
  const input = await fs.open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await input.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error(`Source entry changed while copying: ${source.toString()}`);
    }
    const output = await fs.open(destination, 'wx', 0o600);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let total = 0n;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += BigInt(bytesRead);
        if (total > opened.size) throw new Error('Source file size changed while copying.');
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
          if (bytesWritten === 0) throw new Error('No progress while writing prepared content.');
          offset += bytesWritten;
        }
      }
      if (total !== opened.size) throw new Error('Source file size changed while copying.');
      await output.chmod(Number(opened.mode & 0o777n));
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/** Create an owned snapshot; do not install it, write state or touch any agent. */
export async function prepareDirectory(
  source: string,
  options: PrepareDirectoryOptions,
): Promise<PreparedSource> {
  if (
    !isAbsolute(options.cwd) ||
    !isAbsolute(options.temporaryDirectory) ||
    [...(options.excludedPaths ?? []), ...(options.excludedPrefixes ?? [])].some(
      (path) => !isAbsolute(path),
    )
  ) {
    throw new SourceError(
      'INVALID_SOURCE',
      'Source cwd and temporary base must be absolute paths.',
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
      validatePathText(path);
      const lexical = Buffer.from(resolve(path));
      excluded.push(lexical);
      try {
        excluded.push(await fs.realpath(lexical));
      } catch (cause) {
        // Unresolvable excluded roots have no reachable target; retain the lexical path.
        if (!['ENOENT', 'ENOTDIR', 'ELOOP'].some((code) => hasErrorCode(cause, code))) throw cause;
      }
    }
    const prefixes: Buffer[] = [];
    for (const prefix of [
      join(options.cwd, '.agents', WORKSPACE_PREFIX),
      join(options.cwd, LOCK_TEMP_PREFIX),
      ...(options.excludedPrefixes ?? []),
    ]) {
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
    const isExcluded = (path: Buffer) =>
      excluded.some((root) => within(root, path)) ||
      prefixes.some((prefix) => path.subarray(0, prefix.length).equals(prefix));
    const sourceRoot = await fs.realpath(Buffer.from(identityPath));
    const rootStats = await fs.lstat(sourceRoot);
    if (!rootStats.isDirectory()) {
      throw new SourceError('INVALID_SOURCE', 'Local source must be a directory.');
    }
    if (isExcluded(sourceRoot) || isExcluded(Buffer.from(identityPath))) {
      throw new SourceError('INVALID_SOURCE', 'CLI state cannot be used as a local source.');
    }
    // Check SKILL.md before creating work files; symlinks are validated by the walker.
    await fs.lstat(childPath(sourceRoot, Buffer.from('SKILL.md')));
    const temporaryRoot = await fs.realpath(Buffer.from(resolve(options.temporaryDirectory)));
    if (within(temporaryRoot, sourceRoot)) {
      throw new SourceError(
        'INVALID_SOURCE',
        'Local source cannot be inside the CLI temporary base.',
      );
    }
    workspace = await fs.mkdtemp(join(temporaryRoot.toString(), 'skills-installer-source-'));
    const directory = join(workspace, 'skill');
    const destinationRoot = Buffer.from(directory);

    async function visit(
      path: Buffer,
      destination: Buffer,
      ancestors: ReadonlySet<string>,
    ): Promise<void> {
      if (!within(destinationRoot, destination)) {
        throw new SourceError('INVALID_SOURCE', 'Copy destination escaped the prepared directory.');
      }
      if (isExcluded(path) || within(temporaryRoot, path)) return;
      const canonical = await fs.realpath(path);
      if (isExcluded(canonical) || within(temporaryRoot, canonical)) return;
      const stats = await fs.lstat(canonical);
      if (stats.isDirectory()) {
        const key = `${stats.dev}:${stats.ino}`;
        if (ancestors.has(key)) {
          throw new SourceError('SOURCE_CYCLE', `Directory link cycle at ${path.toString()}.`);
        }
        await fs.mkdir(destination, { mode: 0o755 });
        const nextAncestors = new Set(ancestors).add(key);
        const names = await fs.readdir(canonical);
        names.sort(Buffer.compare);
        for (const name of names) {
          if (
            name.length === 0 ||
            name.equals(Buffer.from('.')) ||
            name.equals(Buffer.from('..')) ||
            name.includes(0) ||
            name.includes(separator)
          ) {
            throw new SourceError('INVALID_SOURCE', 'Invalid directory entry name.');
          }
          await visit(childPath(canonical, name), childPath(destination, name), nextAncestors);
        }
      } else if (stats.isFile()) {
        await copyFile(canonical, destination, stats, fs);
      } else {
        throw new SourceError('UNSUPPORTED_ENTRY', `Unsupported source entry: ${path.toString()}.`);
      }
    }

    await visit(sourceRoot, destinationRoot, new Set());
    const metadata = readSkillMetadata(await fs.readFile(join(directory, 'SKILL.md'), 'utf8'));
    const contentHash = await hashDirectory(directory);
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
    let error =
      cause instanceof SourceError
        ? cause
        : new SourceError(
            hasErrorCode(cause, 'ELOOP')
              ? 'SOURCE_CYCLE'
              : hasErrorCode(cause, 'INVALID_PATH')
                ? 'INVALID_SOURCE'
                : 'PREPARATION_FAILED',
            `Cannot prepare local source ${JSON.stringify(identityPath)}.`,
            { cause },
          );
    if (workspace !== undefined) {
      try {
        await fs.rm(workspace, { recursive: true, force: true });
      } catch (cleanupError) {
        error = new SourceError(
          'PREPARATION_FAILED',
          `Preparation and temporary cleanup failed: ${workspace}.`,
          {
            cause: new AggregateError([error, cleanupError]),
          },
        );
      }
    }
    throw error;
  }
}
