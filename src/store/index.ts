import { openRegularFile, withFileHandle } from '@/regular-file';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isCancellation } from '@/cancellation';
import { userDataDirectory, ensureUserDataDirectory } from '@/config';
import { hasErrorCode } from '@/errors';
import { prepareRegistrySource, verifyRegistrySource } from '@/sources';
import { withFileLock } from '@/state';
import type { RegistryClient, CatalogSkill } from '@/registry';
import type { FileSystemRoots } from '@/runtime';

export interface StoredSkill {
  readonly directory: string;
  readonly contentHash: string;
}

/** Ключ не зависит от project/global: нормализованный registry и digest точного ZIP. */
export function artifactKey(client: RegistryClient, skill: CatalogSkill): string {
  return `${createHash('sha256').update(client.registryUrl).digest('hex')}-${skill.sha256}`;
}

/** Идентичность связывает снимок с точным компонентом; URL загрузки и исходный ZIP не сохраняются. */
function identity(client: RegistryClient, skill: CatalogSkill) {
  return {
    registryUrl: client.registryUrl,
    packageSlug: skill.packageSlug,
    version: skill.version,
    name: skill.name,
    installName: skill.installName,
    archiveHash: skill.sha256,
  };
}

/** Читает и полностью сверяет снимок; повреждение разрешает повторную подготовку, отмена пробрасывается. */
async function inspectEntry(
  path: string,
  client: RegistryClient,
  skill: CatalogSkill,
  signal?: AbortSignal,
): Promise<StoredSkill | null> {
  try {
    signal?.throwIfAborted();
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const metadata = join(path, 'entry.json');
    const expected = await lstat(metadata, { bigint: true });
    if (!expected.isFile() || expected.size > 16_384n) return null;
    const { handle } = await openRegularFile(metadata, { expected, signal });
    const data = JSON.parse(
      await withFileHandle(handle, (file) => file.readFile({ encoding: 'utf8', signal })),
    );
    if (
      !data ||
      typeof data !== 'object' ||
      Object.entries(identity(client, skill)).some(([key, value]) => data[key] !== value)
    )
      return null;
    const directory = join(path, 'content');
    const contentHash = await verifyRegistrySource(directory, skill, signal);
    return data.contentHash === contentHash ? { directory, contentHash } : null;
  } catch (cause) {
    if (isCancellation(cause, signal)) throw cause;
    // Только повреждение/отсутствие трактуется как cache miss; ошибки доступа не маскируются скачиванием.
    if (hasErrorCode(cause, 'EACCES') || hasErrorCode(cause, 'EPERM')) throw cause;
    return null;
  }
}

/**
 * Подготавливает один ключ под межпроцессной блокировкой и атомарно публикует проверенный снимок.
 * Вызывается после свежих метаданных и подтверждения. Callback отмечает только проверенное скачивание.
 * Временные данные принадлежат вызову; готовая запись сохраняется при последующей отмене установки.
 */
export async function withStoredSkill<T>(
  roots: FileSystemRoots,
  client: RegistryClient,
  skill: CatalogSkill,
  downloaded: () => void,
  use: (entry: StoredSkill) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  await ensureUserDataDirectory(roots, true);
  const root = join(userDataDirectory(roots), 'store');
  await mkdir(root).catch((cause: unknown) => {
    if (!hasErrorCode(cause, 'EEXIST')) throw cause;
  });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Ожидался обычный каталог хранилища: ${root}.`);
  const key = artifactKey(client, skill);
  const destination = join(root, key);
  return withFileLock(
    join(root, `${key}.lock`),
    async () => {
      const leftovers = (await readdir(root)).filter((name) => name.startsWith(`${key}.tmp-`));
      if (leftovers.length)
        throw new Error(
          `Остались каталоги подготовки хранилища; требуется проверка: ${leftovers.map((name) => join(root, name)).join(', ')}.`,
        );
      const found = await inspectEntry(destination, client, skill, signal);
      if (found) return use(found);
      const workspace = await mkdtemp(join(root, `${key}.tmp-`));
      let keepRecovery = false;
      try {
        const ready = join(workspace, 'ready');
        await mkdir(ready);
        const bytes = await client.downloadArtifact(skill, signal);
        const contentHash = await prepareRegistrySource(
          bytes,
          skill,
          join(ready, 'content'),
          signal,
        );
        downloaded();
        await writeFile(
          join(ready, 'entry.json'),
          `${JSON.stringify({ ...identity(client, skill), contentHash }, null, 2)}\n`,
          { flag: 'wx', signal },
        );
        signal?.throwIfAborted();
        const old = join(workspace, 'old');
        const exists = await lstat(destination).then(
          () => true,
          (cause: unknown) => {
            if (hasErrorCode(cause, 'ENOENT')) return false;
            throw cause;
          },
        );
        if (exists) await rename(destination, old);
        try {
          await rename(ready, destination);
        } catch (cause) {
          if (exists)
            await rename(old, destination).catch((rollback: unknown) => {
              keepRecovery = true;
              throw new AggregateError(
                [cause, rollback],
                `Не удалось восстановить хранилище: ${workspace}.`,
              );
            });
          throw cause;
        }
        signal?.throwIfAborted();
        return await use({ directory: join(destination, 'content'), contentHash });
      } finally {
        if (!keepRecovery) await rm(workspace, { recursive: true, force: true });
      }
    },
    { ...(signal && { signal }), waitMs: 30_000 },
  );
}
