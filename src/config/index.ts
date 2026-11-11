import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { hasErrorCode } from '@/errors';
import { openRegularFile, withFileHandle } from '@/regular-file';
import { getRegistryUrl } from '@/registry';
import type { FileSystemRoots, RuntimeContext } from '@/runtime';

/** Возвращает пользовательский корень настроек и хранилища; не выполняет I/O. */
export function userDataDirectory(roots: FileSystemRoots): string {
  return join(roots.home, '.skills-installer');
}

/** Проверяет обычный пользовательский каталог; создаёт только при записи, ссылки отклоняет. */
export async function ensureUserDataDirectory(
  roots: FileSystemRoots,
  create = false,
): Promise<boolean> {
  const path = userDataDirectory(roots);
  if (create)
    await mkdir(path).catch((cause: unknown) => {
      if (!hasErrorCode(cause, 'EEXIST')) throw cause;
    });
  const stat = await lstat(path).catch((cause: unknown) => {
    if (hasErrorCode(cause, 'ENOENT')) return null;
    throw cause;
  });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
    throw new Error(`Ожидался обычный каталог настроек: ${path}.`);
  return stat !== null;
}

/** Проверяет тип config без разбора JSON; ошибки доступа и чужие объекты не означают отсутствие файла. */
async function inspectConfigFile(path: string): Promise<BigIntStats | null> {
  const stats = await lstat(path, { bigint: true }).catch((cause: unknown) => {
    if (hasErrorCode(cause, 'ENOENT')) return null;
    throw cause;
  });
  if (stats && !stats.isFile()) throw new Error(`Ожидался обычный файл настроек: ${path}.`);
  return stats;
}

/** Читает сохранённый URL; повреждение требует явного set/unset, I/O-ошибки сохраняют свою причину. */
export async function readRegistryConfig(roots: FileSystemRoots): Promise<string | undefined> {
  if (!(await ensureUserDataDirectory(roots))) return undefined;
  const path = join(userDataDirectory(roots), 'config.json');
  const expected = await inspectConfigFile(path);
  if (!expected) return undefined;
  const { handle } = await openRegularFile(path, { expected });
  const contents = await withFileHandle(handle, (file) => file.readFile('utf8'));
  try {
    const data: unknown = JSON.parse(contents);
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      Object.keys(data).some((key) => key !== 'registry') ||
      ('registry' in data && typeof data.registry !== 'string')
    )
      throw new Error('Некорректная структура настройки registry.');
    return 'registry' in data ? getRegistryUrl(data.registry as string, {}) : undefined;
  } catch (cause) {
    throw new Error(
      `Повреждён файл настроек: ${path}. Выполните skills-installer config set registry <url> или skills-installer config unset registry.`,
      { cause },
    );
  }
}

/**
 * Атомарно заменяет обычный config, включая повреждённый JSON, либо снимает настройку без HTTP.
 * Новый URL проверяется до I/O; подмена файла и отмена до rename останавливают замену config.
 * Временным файлом и его очисткой владеет эта функция; I/O-ошибки не скрываются.
 */
export async function writeRegistryConfig(
  roots: FileSystemRoots,
  value?: string,
  signal?: AbortSignal,
): Promise<void> {
  const registry = value === undefined ? undefined : getRegistryUrl(value, {});
  signal?.throwIfAborted();
  await ensureUserDataDirectory(roots, true);
  const path = join(userDataDirectory(roots), 'config.json');
  const expected = await inspectConfigFile(path);
  if (expected) {
    const { handle } = await openRegularFile(path, { expected, signal });
    await handle.close();
  }
  const temporary = join(userDataDirectory(roots), `.config-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    await withFileHandle(handle, async () => {
      await handle.writeFile(
        `${JSON.stringify(registry === undefined ? {} : { registry }, null, 2)}\n`,
      );
      await handle.sync();
    });
    const current = await inspectConfigFile(path);
    if (
      expected === null
        ? current !== null
        : current === null ||
          expected.dev !== current.dev ||
          expected.ino !== current.ino ||
          expected.size !== current.size ||
          expected.mtimeNs !== current.mtimeNs ||
          expected.ctimeNs !== current.ctimeNs
    )
      throw new Error(`Файл настроек изменился во время записи: ${path}. Повторите команду.`);
    signal?.throwIfAborted();
    await rename(temporary, path);
  } catch (cause) {
    await unlink(temporary).catch((cleanup: unknown) => {
      if (!hasErrorCode(cleanup, 'ENOENT'))
        throw new AggregateError([cause, cleanup], 'Не удалось очистить временные настройки.');
    });
    throw cause;
  }
}

/** Выбирает registry для нового add/find, обращаясь к диску только при отсутствии override. */
export async function resolveRegistryUrl(
  explicit: string | undefined,
  context: RuntimeContext,
): Promise<string> {
  return getRegistryUrl(
    explicit,
    context.env,
    explicit?.trim() || context.env.SKILLS_API_URL?.trim()
      ? undefined
      : await readRegistryConfig(context.roots),
  );
}
