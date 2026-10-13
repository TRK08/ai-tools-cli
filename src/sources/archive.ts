import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createGunzip } from 'node:zlib';
import { Parser, ReadEntry } from 'tar';
import { hasErrorCode } from '../state/errors.ts';
import { hashDirectory } from '../state/hash.ts';
import { validatePathText } from '../state/paths.ts';
import { SourceError } from './errors.ts';
import { archiveSourceFileSystem, type ArchiveSourceFileSystem } from './filesystem.ts';
import { readSkillMetadata } from './frontmatter.ts';
import type { PreparedSource } from './types.ts';

export const ARCHIVE_LIMITS = Object.freeze({
  inputBytes: 20 * 1024 * 1024,
  extractedBytes: 25 * 1024 * 1024,
  entries: 1000,
});
// Bound headers, PAX metadata and padding too, including data ignored by the parser.
const MAX_TAR_BYTES = ARCHIVE_LIMITS.extractedBytes + 4 * 1024 * 1024;

export interface PrepareArchiveOptions {
  readonly cwd: string;
  readonly temporaryDirectory: string;
  readonly fileSystem?: ArchiveSourceFileSystem;
}

interface ArchiveEntry {
  readonly path: string;
  readonly directory: boolean;
  readonly mode: number;
  readonly chunks: Buffer[];
}

function invalid(message: string): never {
  throw new SourceError('INVALID_ARCHIVE', message);
}

function safePath(raw: string, directory: boolean): string {
  const path = raw.replace(/\\/g, '/');
  if (
    /\p{Cc}/u.test(path) ||
    path.startsWith('/') ||
    /^[a-zA-Z]:/.test(path) ||
    path.split('/').includes('..')
  )
    invalid(`Archive contains an unsafe path: ${JSON.stringify(raw)}.`);
  const normalized = path
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
  if (/^[a-zA-Z]:/.test(normalized))
    invalid(`Archive contains an unsafe path: ${JSON.stringify(raw)}.`);
  if (!normalized && !directory) invalid('Archive file path is empty.');
  return normalized;
}

async function readArchive(path: string, fs: ArchiveSourceFileSystem): Promise<Buffer> {
  const canonical = await fs.realpath(path);
  const expected = await fs.lstat(canonical);
  if (!expected.isFile()) {
    throw new SourceError('INVALID_SOURCE', 'Local archive source must be a regular file.');
  }
  const input = await fs.open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stats = await input.stat();
    if (!stats.isFile() || stats.dev !== expected.dev || stats.ino !== expected.ino)
      throw new Error('Archive source changed while opening.');
    if (stats.size > ARCHIVE_LIMITS.inputBytes)
      throw new SourceError('ARCHIVE_LIMIT', 'Archive exceeds the 20 MiB input limit.');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > ARCHIVE_LIMITS.inputBytes)
        throw new SourceError('ARCHIVE_LIMIT', 'Archive exceeds the 20 MiB input limit.');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (bytes !== stats.size) throw new Error('Archive size changed while reading.');
    return Buffer.concat(chunks, bytes);
  } finally {
    await input.close();
  }
}

/** Parse bounded gzip/tar data with tar; filesystem writes happen only after validation. */
async function unpack(bytes: Buffer): Promise<readonly ArchiveEntry[]> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) invalid('Expected a gzip-compressed tar archive.');
  const entries = new Map<string, ArchiveEntry>();
  let count = 0;
  let declaredBytes = 0;
  let actualBytes = 0;
  let tarBytes = 0;
  let eof = false;
  let bodyBytes = 0;
  let parseError: Error | undefined;
  const parser = new Parser({
    strict: true,
    maxMetaEntrySize: 1024 * 1024,
    filter(_path, entry) {
      if (!(entry instanceof ReadEntry)) invalid('Expected a tar stream entry.');
      if (!['File', 'OldFile', 'Directory'].includes(entry.type))
        invalid(`Archive links and special entries are not supported: ${entry.type}.`);
      if (++count > ARCHIVE_LIMITS.entries)
        throw new SourceError('ARCHIVE_LIMIT', 'Archive exceeds the 1000 entry limit.');
      const directory = entry.type === 'Directory';
      const path = safePath(entry.path, directory);
      if (entries.has(path)) invalid(`Duplicate archive path: ${JSON.stringify(path)}.`);
      if (!Number.isSafeInteger(entry.size) || entry.size < 0)
        invalid('Invalid archive entry size.');
      declaredBytes += entry.size;
      if (declaredBytes > ARCHIVE_LIMITS.extractedBytes)
        throw new SourceError('ARCHIVE_LIMIT', 'Archive exceeds the 25 MiB extracted-file limit.');
      entries.set(path, { path, directory, mode: (entry.mode ?? 0o644) & 0o777, chunks: [] });
      bodyBytes = entry.startBlockSize;
      return true;
    },
    onReadEntry(entry: ReadEntry) {
      const target = entries.get(safePath(entry.path, entry.type === 'Directory'))!;
      let entryBytes = 0;
      entry.on('data', (chunk: Buffer) => {
        entryBytes += chunk.length;
        actualBytes += chunk.length;
        if (actualBytes > ARCHIVE_LIMITS.extractedBytes)
          throw new SourceError(
            'ARCHIVE_LIMIT',
            'Archive exceeds the 25 MiB extracted-file limit.',
          );
        target.chunks.push(chunk);
      });
      entry.on('end', () => {
        if (entryBytes !== entry.size) invalid('Truncated archive entry.');
      });
      entry.resume();
    },
  });
  // Unknown types and oversized metadata must fail instead of being silently skipped.
  parser.on('ignoredEntry', () =>
    invalid('Archive contains an unsupported entry or oversized metadata.'),
  );
  parser.on('error', (error: Error) => {
    parseError = error;
  });
  parser.on('eof', () => {
    eof = true;
  });
  const ended = new Promise<void>((complete) => parser.once('end', complete));
  const gzip = createGunzip();
  gzip.end(bytes);
  let pending: Buffer = Buffer.alloc(0);
  try {
    for await (const chunk of gzip) {
      tarBytes += chunk.length;
      if (tarBytes > MAX_TAR_BYTES)
        throw new SourceError('ARCHIVE_LIMIT', 'Archive exceeds the tar metadata/padding limit.');
      const buffer: Buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      while (buffer.length - offset >= 512) {
        if (eof) {
          if (buffer.subarray(offset).some((byte) => byte !== 0))
            invalid('Unexpected data after tar end blocks.');
          offset = buffer.length;
          break;
        }
        // Feed headers individually so EOF cannot hide data in the same gzip chunk.
        // File bodies stay in large chunks; PAX/GNU metadata is parsed in blocks.
        const body = bodyBytes > 0;
        const length = body
          ? Math.min(bodyBytes, Math.floor((buffer.length - offset) / 512) * 512)
          : 512;
        parser.write(buffer.subarray(offset, offset + length));
        if (body) bodyBytes -= length;
        offset += length;
        if (parseError) throw parseError;
      }
      pending = buffer.subarray(offset);
    }
    if (pending.length) invalid('Truncated tar archive: partial block.');
    parser.end();
    if (parseError) throw parseError;
    await ended;
    if (!eof || tarBytes % 512 !== 0)
      invalid('Truncated tar archive: missing complete end blocks.');
    for (const entry of entries.values()) {
      let parent = dirname(entry.path);
      while (parent !== '.') {
        if (entries.get(parent)?.directory === false)
          invalid(`Archive file is also used as a directory: ${JSON.stringify(parent)}.`);
        parent = dirname(parent);
      }
    }
    return [...entries.values()];
  } catch (cause) {
    if (cause instanceof SourceError) throw cause;
    throw new SourceError('INVALID_ARCHIVE', 'Invalid or truncated gzip/tar archive.', { cause });
  } finally {
    gzip.destroy();
  }
}

/** Prepare one local archive without agent, state, registry or HTTP dependencies. */
export async function prepareArchive(
  source: string,
  options: PrepareArchiveOptions,
): Promise<PreparedSource> {
  if (!isAbsolute(options.cwd) || !isAbsolute(options.temporaryDirectory))
    throw new SourceError(
      'INVALID_SOURCE',
      'Source cwd and temporary base must be absolute paths.',
    );
  const identityPath = resolve(options.cwd, source);
  const fs = options.fileSystem ?? archiveSourceFileSystem;
  let workspace: string | undefined;
  try {
    validatePathText(source);
    validatePathText(options.cwd);
    validatePathText(options.temporaryDirectory);
    if (!/\.(?:tar\.gz|tgz)$/.test(source))
      throw new SourceError('INVALID_SOURCE', 'Local archive must end in .tar.gz or .tgz.');
    const bytes = await readArchive(identityPath, fs);
    const archiveHash = createHash('sha256').update(bytes).digest('hex');
    const entries = await unpack(bytes);
    const rootSkill = entries.find((entry) => entry.path === 'SKILL.md' && !entry.directory);
    let prefix = '';
    if (!rootSkill) {
      const topLevel = new Set(entries.map((entry) => entry.path.split('/')[0]).filter(Boolean));
      const outer = [...topLevel][0];
      if (
        topLevel.size !== 1 ||
        !entries.some((entry) => entry.path === `${outer}/SKILL.md` && !entry.directory)
      )
        invalid('SKILL.md must be at archive root or in its single outer directory.');
      prefix = `${outer}/`;
    }
    const temporaryRoot = await fs.realpath(options.temporaryDirectory);
    workspace = await fs.mkdtemp(join(temporaryRoot, 'skills-installer-archive-'));
    const directory = join(workspace, 'skill');
    await fs.mkdir(directory, { mode: 0o755 });
    for (const entry of entries) {
      const path = prefix ? entry.path.slice(prefix.length) : entry.path;
      if (!path) continue;
      const target = resolve(directory, path);
      if (!target.startsWith(`${directory}/`))
        invalid('Archive destination escaped temporary root.');
      if (entry.directory) await fs.mkdir(target, { recursive: true, mode: 0o755 });
      else {
        await fs.mkdir(dirname(target), { recursive: true, mode: 0o755 });
        const output = await fs.open(target, 'wx', 0o600);
        try {
          for (const chunk of entry.chunks) await output.writeFile(chunk);
          await output.chmod(entry.mode);
        } finally {
          await output.close();
        }
      }
    }
    const metadata = readSkillMetadata(await fs.readFile(join(directory, 'SKILL.md'), 'utf8'));
    const contentHash = await hashDirectory(directory);
    const ownedWorkspace = workspace;
    return Object.freeze({
      directory,
      ...metadata,
      identity: { kind: 'archive' as const, path: identityPath },
      version: null,
      contentHash,
      archiveHash,
      cleanup: () => fs.rm(ownedWorkspace, { recursive: true, force: true }),
    });
  } catch (cause) {
    let error =
      cause instanceof SourceError
        ? cause
        : new SourceError(
            hasErrorCode(cause, 'INVALID_PATH') ? 'INVALID_SOURCE' : 'PREPARATION_FAILED',
            `Cannot prepare local archive ${JSON.stringify(identityPath)}.`,
            { cause },
          );
    if (workspace !== undefined) {
      try {
        await fs.rm(workspace, { recursive: true, force: true });
      } catch (cleanupError) {
        error = new SourceError(
          'PREPARATION_FAILED',
          `Preparation and temporary cleanup failed: ${workspace}.`,
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
    }
    throw error;
  }
}
