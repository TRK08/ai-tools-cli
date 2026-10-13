import type { RegistryArtifact } from '../registry/client.ts';
import { getSkillDirectory, portableSourcePath, type StatePaths } from '../state/paths.ts';
import type { InstallationRecord, ManagedConnection } from '../state/types.ts';
import type { SourceIdentity } from '../sources/types.ts';
import type { InstallationScope } from '../runtime.ts';
import type {
  AddPreview,
  InstalledSnapshot,
  InstallationContent,
  InstallPlan,
  UpdatePreview,
} from './types.ts';

/** Разрешает заимствовать копию только при совпадении версии, архива и проверенного хеша. */
export function findReusableInstallation(
  previous: InstallationRecord | undefined,
  artifact: RegistryArtifact | null,
  installedHash: string | null,
): InstallationRecord | null {
  return artifact &&
    previous &&
    previous.version === artifact.version &&
    previous.archiveHash === artifact.sha256 &&
    installedHash === previous.contentHash
    ? previous
    : null;
}

/** Сравнивает сохраняемые метаданные отдельно от физических изменений файлов. */
export function metadataChanged(
  previous: InstallationRecord | undefined,
  content: Pick<InstallationContent, 'version' | 'contentHash' | 'archiveHash'>,
  policy: InstallationRecord['policy'],
): boolean {
  return (
    previous?.contentHash !== content.contentHash ||
    previous.version !== content.version ||
    previous.archiveHash !== content.archiveHash ||
    previous.policy !== policy
  );
}

/** Рассчитывает намерение по снимку; не читает файлы и не изменяет переданные данные. */
export function createInstallPlan(
  content: InstallationContent,
  snapshot: InstalledSnapshot,
  identity: SourceIdentity,
  policy: InstallationRecord['policy'],
  reviewedUnchanged = false,
  force = false,
): InstallPlan {
  const intact =
    snapshot.contentHash === content.contentHash &&
    !snapshot.connectionsNeedRepair &&
    !snapshot.errors.length &&
    snapshot.candidates.length > 0 &&
    snapshot.candidates.every((candidate) =>
      snapshot.previous?.connections.some((connection) => connection.agent === candidate.agent),
    );
  return {
    kind: intact
      ? metadataChanged(snapshot.previous, content, policy)
        ? 'metadata-only'
        : 'unchanged'
      : 'apply',
    content,
    snapshot,
    identity,
    policy,
    reviewedUnchanged,
    force,
  };
}

/** Формирует карточку из уже выбранной версии и заранее вычисленных путей без I/O. */
export function createAddPreview(
  content: Pick<InstallationContent, 'name' | 'version' | 'description' | 'identity'>,
  paths: StatePaths,
  policy: InstallationRecord['policy'],
  destinations: AddPreview['destinations'],
): AddPreview {
  return {
    name: content.name,
    version: content.version,
    description: content.description,
    source: content.identity,
    scope: paths.scope,
    policy,
    sharedDirectory: getSkillDirectory(paths, content.name),
    destinations,
  };
}

/** Формирует строку обновления; pinned и unchanged не требуют подтверждения изменений. */
export function createUpdatePreview(
  record: InstallationRecord,
  scope: InstallationScope,
  latestVersion: string | null,
  reason: UpdatePreview['reason'],
): UpdatePreview {
  return {
    name: record.name,
    currentVersion: record.version,
    latestVersion,
    sourceKind: record.source.kind,
    scope,
    agents: record.agents,
    status: reason === 'pinned' ? 'pinned' : reason === null ? 'unchanged' : 'available',
    reason,
  };
}

/** Выбирает наиболее существенную причину registry-обновления в прежнем порядке. */
export function registryUpdateReason(
  record: InstallationRecord,
  artifact: RegistryArtifact,
  installedHash: string | null,
  connectionsNeedRepair: boolean,
): UpdatePreview['reason'] {
  return record.version !== artifact.version
    ? 'version'
    : record.archiveHash !== artifact.sha256
      ? 'artifact'
      : installedHash !== record.contentHash
        ? 'copy'
        : connectionsNeedRepair
          ? 'connections'
          : null;
}

/** Отличает ручную правку копии от нового локального снимка и восстановления подключений. */
export function localUpdateReason(
  record: InstallationRecord,
  content: InstallationContent,
  snapshot: InstalledSnapshot,
): UpdatePreview['reason'] {
  return snapshot.contentHash !== record.contentHash
    ? 'copy'
    : content.contentHash !== record.contentHash
      ? 'source'
      : content.archiveHash !== record.archiveHash
        ? 'artifact'
        : snapshot.connectionsNeedRepair
          ? 'connections'
          : null;
}

/** Собирает запись lock только из фактически сохранённых подключений и выбранного источника. */
export function createInstallationRecord(
  plan: InstallPlan,
  paths: StatePaths,
  connections: readonly ManagedConnection[],
): InstallationRecord {
  const { content, identity, snapshot, policy } = plan;
  return {
    name: content.name,
    source:
      identity.kind === 'registry'
        ? identity
        : { ...identity, path: portableSourcePath(identity.path, paths) },
    version: content.version,
    policy,
    contentHash: content.contentHash,
    ...(content.archiveHash === undefined ? {} : { archiveHash: content.archiveHash }),
    agents: [
      ...new Set([...(snapshot.previous?.agents ?? []), ...connections.map((item) => item.agent)]),
    ],
    connections,
  };
}
