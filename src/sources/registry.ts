import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { RegistryArtifact, RegistryClient, RegistryDownload } from '../registry/client.ts';
import { RegistryError } from '../registry/errors.ts';
import type { RegistryReference } from '../registry/reference.ts';
import { prepareArchive, type PrepareArchiveOptions } from './archive.ts';
import { SourceError } from './errors.ts';
import type { PreparedSource } from './types.ts';

export async function prepareRegistrySource(
  reference: RegistryReference,
  client: RegistryClient,
  options: PrepareArchiveOptions,
  onDownload?: (download: RegistryDownload) => void,
  resolvedArtifact?: RegistryArtifact,
): Promise<PreparedSource> {
  if (!isAbsolute(options.cwd) || !isAbsolute(options.temporaryDirectory))
    throw new SourceError(
      'INVALID_SOURCE',
      'Пути рабочей папки и временного каталога должны быть абсолютными.',
    );
  const artifact = resolvedArtifact ?? (await client.resolveArtifact(reference));
  if (
    artifact.slug !== reference.slug ||
    (reference.version !== undefined && artifact.version !== reference.version)
  )
    throw new RegistryError(
      'ARTIFACT_MISMATCH',
      'Артефакт не соответствует запрошенному скиллу или версии.',
    );
  const { bytes, download } = await client.downloadArtifact(artifact);
  onDownload?.(download);
  const workspace = await mkdtemp(join(options.temporaryDirectory, 'skills-installer-download-'));
  try {
    const archive = join(workspace, 'artifact.tar.gz');
    await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
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
      cleanup: () => rm(workspace, { recursive: true, force: true }),
    });
  } catch (cause) {
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new Error(
        `Подготовка из реестра и удаление временных файлов завершились ошибкой: ${workspace}.`,
        {
          cause: new AggregateError([cause, cleanupError]),
        },
      );
    }
    throw cause;
  }
}
