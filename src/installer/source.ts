import { nativePath } from '../state/native-path.ts';
import { AGENTS } from '../agents/catalog.ts';
import { agentSkillsDirectory } from './agents.ts';
import {
  localSourceIdentity,
  prepareLocalSource,
  registryReferenceForSource,
} from '../sources/local.ts';
import { prepareRegistrySource } from '../sources/registry.ts';
import { RegistryClient } from '../registry/client.ts';
import { RegistryError } from '../registry/errors.ts';
import type { RegistryDownload } from '../registry/client.ts';
import { getRegistryUrl } from '../registry/reference.ts';
import type { PrepareDirectoryOptions } from '../sources/directory.ts';
import type { RuntimeContext } from '../runtime.ts';
import type { InstallationRecord } from '../state/types.ts';
import {
  getSkillDirectory,
  getStatePaths,
  portableSourcePath,
  resolveConnectionPath,
  INSTALLER_LOCK_NAME,
  LOCK_TEMP_PREFIX,
  WORKSPACE_PREFIX,
  type StatePaths,
} from '../state/paths.ts';
import type {
  InstallationContent,
  InstallerOptions,
  RegistrySelection,
  SourceSelection,
} from './types.ts';

/** Проверяет переносимость пути до I/O и выбирает источник/политику; update сохраняет registry. */
export async function selectSource(
  input: string,
  context: RuntimeContext,
  paths: StatePaths,
  options: InstallerOptions,
  updating?: InstallationRecord,
  selection?: RegistrySelection,
): Promise<SourceSelection> {
  // Проверка выполняется до чтения источника, workspace и сетевых запросов.
  portableSourcePath(input, paths);
  const reference = updating
    ? updating.source.kind === 'registry'
      ? { slug: updating.source.slug }
      : null
    : (selection ?? (await registryReferenceForSource(input, paths.cwd)));
  const client =
    reference === null
      ? null
      : new RegistryClient(
          updating?.source.kind === 'registry'
            ? updating.source.registryUrl
            : getRegistryUrl(options.registry, context.env),
          context.http,
          options.registryClientOptions,
        );
  const identity =
    reference && client
      ? { kind: 'registry' as const, registryUrl: client.registryUrl, slug: reference.slug }
      : await localSourceIdentity(input, paths.cwd);
  return {
    input,
    identity,
    policy:
      updating?.policy ??
      selection?.policy ??
      (reference === null ? 'local' : reference.version === undefined ? 'latest' : 'exact'),
    registry: reference && client ? { reference, client } : null,
    artifact: null,
  };
}

/** Фиксирует выбранную версию до подтверждения; повторная подготовка использует этот артефакт. */
export async function resolveSelectedSource(
  source: SourceSelection,
  signal?: AbortSignal,
): Promise<SourceSelection> {
  return {
    ...source,
    artifact: source.registry
      ? await source.registry.client.resolveArtifact(source.registry.reference, signal)
      : null,
  };
}

/** Задаёт политику имён; исключает default/активные каталоги всех агентов, состояние обоих scopes и сохранённые назначения. */
export function preparationOptions(
  context: RuntimeContext,
  paths: StatePaths,
  workspace: string,
  signal?: AbortSignal,
  records: readonly InstallationRecord[] = [],
): Omit<PrepareDirectoryOptions, 'fileSystem'> {
  const { join } = nativePath;
  const global = getStatePaths(context.roots, 'global');
  return {
    signal,
    portableNames: paths.scope === 'project',
    cwd: paths.cwd,
    temporaryDirectory: workspace,
    excludedPaths: [
      ...AGENTS.flatMap((agent) =>
        (['project', 'global'] as const).flatMap((scope) => [
          agent[scope].directory(context.roots),
          agentSkillsDirectory(context, scope, agent.id),
        ]),
      ),
      join(context.roots.cwd, '.agents', 'skills'),
      join(context.roots.cwd, INSTALLER_LOCK_NAME),
      join(context.roots.cwd, '.skills-installer-operation.lock'),
      global.skillsDirectory,
      global.lockPath,
      global.operationLockPath,
      ...records.flatMap((record) =>
        record.connections.map((connection) => resolveConnectionPath(connection.path, paths)),
      ),
    ],
    excludedPrefixes: [
      join(context.roots.cwd, '.agents', WORKSPACE_PREFIX),
      join(context.roots.cwd, LOCK_TEMP_PREFIX),
      join(global.agentsDirectory, WORKSPACE_PREFIX),
      join(global.root, LOCK_TEMP_PREFIX),
    ],
  };
}

/** Представляет установленную копию как заимствованное содержимое без права очистки. */
export function reusableContent(
  record: InstallationRecord,
  paths: StatePaths,
): InstallationContent {
  return {
    ownership: 'reuse',
    name: record.name,
    description: null,
    identity: record.source,
    directory: getSkillDirectory(paths, record.name),
    version: record.version,
    contentHash: record.contentHash,
    ...(record.archiveHash === undefined ? {} : { archiveHash: record.archiveHash }),
  };
}

/**
 * Готовит снимок выбранного источника внутри переданной базы.
 *
 * @remarks Workspace целиком принадлежит FileTransaction; cleanup адаптера здесь не вызывается.
 * @throws RegistryError — если registry-версия ещё не разрешена.
 */
export async function prepareSelectedSource(
  source: SourceSelection,
  options: Omit<PrepareDirectoryOptions, 'fileSystem'>,
  prepare: typeof prepareLocalSource = prepareLocalSource,
  onDownload?: (download: RegistryDownload) => void,
): Promise<InstallationContent> {
  if (source.registry && !source.artifact)
    throw new RegistryError(
      'ARTIFACT_MISMATCH',
      'Выбранный registry-источник не содержит разрешённого артефакта.',
    );
  const prepared = source.registry
    ? await prepareRegistrySource(
        source.registry.reference,
        source.registry.client,
        options,
        onDownload,
        source.artifact!,
      )
    : await prepare(source.input, options);
  return {
    ownership: 'prepared',
    directory: prepared.directory,
    name: prepared.name,
    description: prepared.description,
    identity: prepared.identity,
    version: prepared.version,
    contentHash: prepared.contentHash,
    ...(prepared.archiveHash === undefined ? {} : { archiveHash: prepared.archiveHash }),
    ...(prepared.download === undefined ? {} : { download: prepared.download }),
  };
}
