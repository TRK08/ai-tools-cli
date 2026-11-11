import { join } from 'node:path';
import { getSkillDirectory, resolveConnectionPath, type InstalledSkill } from '@/state';
import { verifyRegistrySource } from '@/sources';
import { withStoredSkill } from '@/store';
import type { FileSystemRoots } from '@/runtime';
import type { RegistryClient } from '@/registry';
import type { InstallationInspection } from './inspection';
import type { FileTransaction } from './filesystem';
import type { PathSnapshot, SkillPlan } from './types';

interface PreparedSkill {
  readonly plan: SkillPlan;
  readonly record?: InstalledSkill;
  readonly source: string;
}

/** Готовит независимые staging-копии из хранилища; отмена освобождает их вместе с файловой транзакцией. */
export async function preparePackage(
  plans: readonly SkillPlan[],
  files: FileTransaction,
  inspection: InstallationInspection,
  client: RegistryClient | undefined,
  downloaded: string[],
  roots: FileSystemRoots,
  signal?: AbortSignal,
): Promise<PreparedSkill[]> {
  const prepared: PreparedSkill[] = [];
  for (const [index, plan] of plans.entries()) {
    signal?.throwIfAborted();
    const { after, before } = plan;
    const installName = (after ?? before)!.installName;
    let source = getSkillDirectory(inspection.paths, installName);
    let contentHash = before?.contentHash;
    if (plan.kind === 'install' && plan.download) {
      if (!client) throw new Error('Для подготовки ZIP требуется клиент реестра.');
      const { component } = plan;
      const staged = await withStoredSkill(
        roots,
        client,
        component,
        () => downloaded.push(component.name),
        async (entry) => {
          const directory = await files.stageCopy(entry.directory, String(index), signal);
          if ((await verifyRegistrySource(directory, component, signal)) !== entry.contentHash)
            throw new Error(`Хеш подготовленной копии ${installName} не совпадает с хранилищем.`);
          return { directory, contentHash: entry.contentHash };
        },
        signal,
      );
      source = staged.directory;
      contentHash = staged.contentHash;
    }
    if (after && !contentHash) throw new Error('Не удалось получить хеш подготовленного скилла.');
    prepared.push({
      plan,
      source,
      ...(after && { record: { ...after, contentHash: contentHash! } }),
    });
  }
  return prepared;
}

/** Отменяет весь пакет, если объект или содержимое изменились после preview. */
function assertUnchanged(
  current: PathSnapshot | null,
  before: PathSnapshot | null,
  path: string,
): void {
  if (current?.identity !== before?.identity || current?.contentHash !== before?.contentHash)
    throw new Error(`Объект изменился после проверки: ${path}. Повторите операцию.`);
}

/** Применяет подготовленные копии и снятие связей. Все изменения регистрируются для отката пакета. */
export async function applyPackage(
  prepared: readonly PreparedSkill[],
  files: FileTransaction,
  inspection: InstallationInspection,
  signal?: AbortSignal,
): Promise<void> {
  const { paths } = inspection;
  for (const [index, { plan, record, source }] of prepared.entries()) {
    signal?.throwIfAborted();
    const { before, snapshot } = plan;
    const installName = (record ?? before)!.installName;
    const shared = getSkillDirectory(paths, installName);
    const replaceShared = plan.kind === 'install' && plan.download;
    if (replaceShared) await inspection.sharedParents(true);
    assertUnchanged(
      await inspection.shared(installName, !!before, signal),
      snapshot.shared,
      shared,
    );
    if ((!record || replaceShared) && snapshot.shared)
      await files.move(shared, join(files.workspace, `old-shared-${index}`), signal);
    if (replaceShared) await files.move(source, shared, signal);
    for (const { connection, snapshot: found } of snapshot.destinations) {
      const keep = record?.connections.some((item) => item.agent === connection.agent);
      const path = resolveConnectionPath(connection.path, paths);
      const create = keep && !found && plan.kind === 'install';
      if (create) await inspection.connectionParents(path, true);
      const owned = before?.connections.some((item) => item.agent === connection.agent) ?? false;
      assertUnchanged(
        await inspection.destination(connection, installName, owned, signal),
        found,
        path,
      );
      if (found && !keep) await files.unlink(path, shared, paths.scope, signal);
      if (create) await files.link(shared, path, paths.scope, signal);
    }
  }
}
