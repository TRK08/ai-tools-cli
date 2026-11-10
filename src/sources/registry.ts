import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  type RegistryArtifact,
  type RegistryClient,
  type RegistryDownload,
  type RegistryReference,
  RegistryError,
} from '@/registry';
import { prepareArchive, type PrepareArchiveOptions } from './archive';
import { SourceError } from './errors';
import type { PreparedSource } from './types';
import { cleanupFailedPreparation, OWNED_WORKSPACE_CLEANUP } from './filesystem';

/**
 * Готовит registry-снимок через проверенное скачивание и адаптер архива с той же политикой имён,
 * сверяя имя со slug. Проверяет отмену между этапами; текущий download завершается до возврата отмены.
 *
 * @param resolvedArtifact - Уже выбранный артефакт; при его наличии latest заново не разрешается.
 * @param onDownload - Вызывается после проверки скачанных байтов, до распаковки и проверки SKILL.md.
 * @remarks Временные ресурсы находятся внутри temporaryDirectory. Прямой потребитель вызывает cleanup;
 * при ошибке очищает весь download-workspace, сохраняя исходную причину и ошибку очистки вместе.
 */
export async function prepareRegistrySource(
  reference: RegistryReference,
  client: RegistryClient,
  options: PrepareArchiveOptions,
  onDownload?: (download: RegistryDownload) => void,
  resolvedArtifact?: RegistryArtifact,
): Promise<PreparedSource> {
  options.signal?.throwIfAborted();
  if (!isAbsolute(options.cwd) || !isAbsolute(options.temporaryDirectory))
    throw new SourceError(
      'INVALID_SOURCE',
      'Пути рабочей папки и временного каталога должны быть абсолютными.',
    );
  const artifact = resolvedArtifact ?? (await client.resolveArtifact(reference, options.signal));
  options.signal?.throwIfAborted();
  if (
    artifact.slug !== reference.slug ||
    (reference.version !== undefined && artifact.version !== reference.version)
  )
    throw new RegistryError(
      'ARTIFACT_MISMATCH',
      'Артефакт не соответствует запрошенному скиллу или версии.',
    );
  const { bytes, download } = await client.downloadArtifact(artifact);
  options.signal?.throwIfAborted();
  onDownload?.(download);
  const workspace = await mkdtemp(join(options.temporaryDirectory, 'skills-installer-download-'));
  try {
    options.signal?.throwIfAborted();
    const archive = join(workspace, 'artifact.tar.gz');
    await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
    options.signal?.throwIfAborted();
    const prepared = await prepareArchive(archive, { ...options, temporaryDirectory: workspace });
    if (prepared.archiveHash !== artifact.sha256)
      throw new RegistryError(
        'ARTIFACT_MISMATCH',
        'Артефакт изменился во время подготовки архива.',
      );
    if (prepared.name !== reference.slug)
      throw new RegistryError(
        'ARTIFACT_MISMATCH',
        'Имя в SKILL.md не соответствует запрошенному slug реестра.',
      );
    return Object.freeze({
      ...prepared,
      identity: {
        kind: 'registry' as const,
        registryUrl: client.registryUrl,
        slug: reference.slug,
      },
      version: artifact.version,
      download,
      cleanup: () => rm(workspace, OWNED_WORKSPACE_CLEANUP),
    });
  } catch (cause) {
    return cleanupFailedPreparation(
      workspace,
      cause,
      { rm },
      (cause) =>
        new Error(
          `Подготовка из реестра и удаление временных файлов завершились ошибкой: ${workspace}.`,
          { cause },
        ),
    );
  }
}
