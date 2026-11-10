import { getSkillDirectory, type InstalledSkill } from '@/state';
import type { CatalogSkill } from '@/registry';
import type { AgentId } from '@/agents';
import type { InstallationInspection } from './inspection';
import type { SkillPlan, SkillPreview } from './types';

/** Планирует установку, обновление или восстановление копий, проверив владение путями. */
export async function planInstall(
  inspection: InstallationInspection,
  component: CatalogSkill,
  before: InstalledSkill | undefined,
  agents: readonly AgentId[],
  versionChanged: boolean,
  signal?: AbortSignal,
): Promise<SkillPlan | undefined> {
  const { name, installName, sha256 } = component;
  if (before && before.installName !== installName)
    throw new Error(`Имя установки компонента ${name} изменилось в реестре.`);
  if (before && !versionChanged && sha256 !== before.archiveHash)
    throw new Error(`ZIP компонента ${name} изменился в пределах одного релиза.`);
  const previous = before?.connections ?? [];
  const target = [...new Set([...previous.map((item) => item.agent), ...agents])].map((agent) =>
    inspection.connection(installName, agent, before),
  );
  const snapshot = await inspection.snapshot(installName, before, target, signal);
  const download =
    versionChanged || !snapshot.shared || snapshot.shared.contentHash !== before?.contentHash;
  const repair = snapshot.destinations.some(({ snapshot: found }) => !found);
  if (!download && !repair && target.length === previous.length) return undefined;
  return {
    kind: 'install',
    before,
    after: { name, installName, archiveHash: sha256, connections: target },
    snapshot,
    component,
    download,
  };
}

/** Планирует снятие выбранных подключений. Снятие последнего удаляет и общую копию. */
export async function planRemoval(
  inspection: InstallationInspection,
  before: InstalledSkill,
  agents: readonly AgentId[],
  signal?: AbortSignal,
): Promise<SkillPlan | undefined> {
  const remaining = before.connections.filter((item) => !agents.includes(item.agent));
  if (remaining.length === before.connections.length) return undefined;
  const snapshot = await inspection.snapshot(before.installName, before, [], signal);
  return {
    kind: 'remove',
    before,
    after: remaining.length ? { ...before, connections: remaining } : undefined,
    snapshot,
  };
}

/** Показывает изменяемые связи и только те ручные правки, которые будут потеряны. */
export function skillPreview(plan: SkillPlan, inspection: InstallationInspection): SkillPreview {
  const { before, after, snapshot } = plan;
  const install = plan.kind === 'install';
  const record = after ?? before!;
  const modifiedPaths: string[] = [];
  if (
    snapshot.shared &&
    before &&
    (!after || (install && plan.download)) &&
    snapshot.shared.contentHash !== before.contentHash
  )
    modifiedPaths.push(getSkillDirectory(inspection.paths, record.installName));
  const affected = install
    ? plan.after.connections
    : plan.before.connections.filter((item) => !after?.connections.includes(item));
  return {
    name: record.name,
    action: !after ? 'remove' : !install ? 'disconnect' : before ? 'update' : 'add',
    agents: affected.map((item) => item.agent),
    modifiedPaths,
  };
}
