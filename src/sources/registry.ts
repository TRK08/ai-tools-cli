import { openRegularFile, withFileHandle } from '@/regular-file';
import { isCancellation } from '@/cancellation';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fromBufferPromise } from 'yauzl';
import { portableNameKey } from '@/paths';
import type { CatalogSkill } from '@/registry';
import { hashDirectory } from '@/state';
import { SourceError } from './errors';
import { readSkillMetadata } from './frontmatter';

const DESCRIPTOR = 'component.json';
const MAX_FILES = 1000;
const MAX_EXPANDED = 25 * 1024 * 1024;
const MAX_DESCRIPTOR = 1024 * 1024;

interface ArchiveFile {
  readonly bytes: Buffer;
  readonly mode: number;
}

function invalid(message: string): never {
  throw new SourceError('INVALID_ARCHIVE', message);
}

/** Отклоняет дубликаты, пересечения каталогов и файлов и коллизии переносимых имён. */
function registerPath(path: string, seen: Map<string, { path: string; file: boolean }>): void {
  const parts = path.split('/');
  if (parts.length > 12 || Buffer.byteLength(path) > 512) invalid('Слишком длинный путь в ZIP.');
  let key = '';
  let prefix = '';
  for (const [index, part] of parts.entries()) {
    key += '/' + portableNameKey(part);
    prefix += '/' + part;
    const file = index === parts.length - 1;
    const existing = seen.get(key);
    if (existing && (existing.path !== prefix || existing.file || file))
      invalid(`Повторяющийся или пересекающийся путь в ZIP: ${JSON.stringify(path)}.`);
    seen.set(key, { path: prefix, file });
  }
}

/** Читает только обычные UTF-8 файлы из ограниченного ZIP и закрывает reader при любом исходе. */
async function readArchive(bytes: Buffer, signal?: AbortSignal): Promise<Map<string, ArchiveFile>> {
  const zip = await fromBufferPromise(bytes, {
    autoClose: false,
    decodeStrings: false,
    validateEntrySizes: true,
  });
  try {
    if (zip.entryCount > MAX_FILES) invalid('Слишком много файлов в ZIP.');
    const files = new Map<string, ArchiveFile>();
    const paths = new Map<string, { path: string; file: boolean }>();
    let size = 0;
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      const path = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        entry.fileNameRaw,
      );
      registerPath(path, paths);
      const mode = entry.externalFileAttributes >>> 16;
      if (
        (mode & 0o170000) !== 0o100000 ||
        entry.externalFileAttributes & 0x10 ||
        !entry.canDecodeFileData()
      )
        invalid(`ZIP содержит неподдерживаемый объект: ${JSON.stringify(path)}.`);
      size += entry.uncompressedSize;
      if (size > MAX_EXPANDED || (path === DESCRIPTOR && entry.uncompressedSize > MAX_DESCRIPTOR))
        invalid('Размер содержимого ZIP превышает ограничение.');
      const header = await zip.readLocalFileHeaderPromise(entry);
      if (
        !header.fileName.equals(entry.fileNameRaw) ||
        header.compressionMethod !== entry.compressionMethod
      )
        invalid('Заголовки файла ZIP не совпадают.');
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        chunks.push(chunk as Buffer);
      }
      files.set(path, { bytes: Buffer.concat(chunks), mode: mode & 0o777 });
    }
    return files;
  } finally {
    zip.close();
  }
}

/** Сверяет descriptor с релизом и каждый файл с полным перечнем, SHA-256, размером и правами. */
function checkManifest(files: ReadonlyMap<string, ArchiveFile>, skill: CatalogSkill): void {
  const descriptor = files.get(DESCRIPTOR);
  const instruction = files.get('SKILL.md');
  if (!descriptor || !instruction) invalid('В ZIP нужны component.json и корневой SKILL.md.');
  const manifest: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(descriptor.bytes),
  );
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    invalid('Некорректный component.json.');
  const data = manifest as Record<string, unknown>;
  if (
    data.schemaVersion !== 1 ||
    data.kind !== 'skill' ||
    data.package !== skill.packageSlug ||
    data.version !== skill.version ||
    data.name !== skill.name ||
    data.installName !== skill.installName ||
    !Array.isArray(data.files) ||
    data.files.length !== files.size - 1
  )
    invalid('Идентичность или состав component.json не совпадает с выбранным скиллом.');
  const listed = new Set<string>();
  for (const item of data.files) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.path !== 'string' ||
      item.path === DESCRIPTOR ||
      listed.has(item.path)
    )
      invalid('Некорректная или повторяющаяся запись в component.json.');
    const file = files.get(item.path);
    if (
      !file ||
      item.size !== file.bytes.length ||
      item.mode !== file.mode ||
      item.sha256 !== createHash('sha256').update(file.bytes).digest('hex')
    )
      invalid(`Файл ${JSON.stringify(item.path)} не совпадает с component.json.`);
    listed.add(item.path);
  }
  if (
    readSkillMetadata(new TextDecoder('utf-8', { fatal: true }).decode(instruction.bytes)).name !==
    skill.installName
  )
    invalid('Имя в SKILL.md не совпадает с installName реестра.');
}

/** Готовит проверенный снимок ZIP в новом каталоге. Очисткой владеет файловая транзакция. */
export async function prepareRegistrySource(
  bytes: Buffer,
  skill: CatalogSkill,
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  let files: Map<string, ArchiveFile>;
  try {
    signal?.throwIfAborted();
    files = await readArchive(bytes, signal);
    checkManifest(files, skill);
  } catch (cause) {
    if (isCancellation(cause, signal)) throw cause;
    if (cause instanceof SourceError) throw cause;
    throw new SourceError('INVALID_ARCHIVE', 'Не удалось проверить ZIP скилла.', { cause });
  }
  signal?.throwIfAborted();
  await mkdir(directory);
  for (const [path, file] of files) {
    signal?.throwIfAborted();
    const target = join(directory, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    const mode = 0o644 | (file.mode & 0o111);
    await writeFile(target, file.bytes, { flag: 'wx', mode, signal });
    await chmod(target, mode);
  }
  return hashDirectory(directory, { signal });
}

/** Проверяет обычные файлы сохранённого снимка, descriptor, байты и executable на POSIX. Ссылки запрещены. */
export async function verifyRegistrySource(
  directory: string,
  skill: CatalogSkill,
  signal?: AbortSignal,
): Promise<string> {
  const files = new Map<string, ArchiveFile>();
  let size = 0;
  const paths = new Map<string, { path: string; file: boolean }>();
  const visit = async (relative: string): Promise<void> => {
    signal?.throwIfAborted();
    const path = join(directory, relative);
    const stats = await lstat(path, { bigint: true });
    if (stats.isDirectory()) {
      if (relative.split('/').length > 12) invalid('Слишком глубокое дерево снимка.');
      for (const name of await readdir(path)) await visit(relative ? `${relative}/${name}` : name);
    } else if (stats.isFile()) {
      registerPath(relative, paths);
      size += Number(stats.size);
      if (
        size > MAX_EXPANDED ||
        files.size >= MAX_FILES ||
        (relative === DESCRIPTOR && stats.size > BigInt(MAX_DESCRIPTOR))
      )
        invalid('Размер снимка превышает ограничение.');
      const { handle } = await openRegularFile(path, { expected: stats, signal });
      const bytes = await withFileHandle(handle, (file) => file.readFile({ signal }));
      files.set(relative, { bytes, mode: Number(stats.mode & 0o777n) });
    } else invalid(`Снимок содержит ссылку или специальный объект: ${path}.`);
  };
  await visit('');
  // Windows не хранит POSIX executable; descriptor всё равно проверяет полный состав и bytes.
  const descriptor = files.get(DESCRIPTOR);
  if (descriptor) {
    const data = JSON.parse(descriptor.bytes.toString('utf8'));
    for (const entry of Array.isArray(data.files) ? data.files : []) {
      const file = files.get(entry.path);
      if (!file) continue;
      if (process.platform !== 'win32' && (file.mode & 0o111) !== (entry.mode & 0o111))
        invalid(`Исполняемые права файла ${entry.path} изменились.`);
      files.set(entry.path, { ...file, mode: entry.mode });
    }
  }
  checkManifest(files, skill);
  return hashDirectory(directory, { signal });
}
