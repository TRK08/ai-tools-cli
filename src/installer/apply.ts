import { dirname, join, relative } from 'node:path';
import { errorMessage } from '../errors.ts';
import { getSkillDirectory, resolveConnectionPath } from '../state/paths.ts';
import { samePath } from '../state/native-path.ts';
import type { StateTransaction } from '../state/store.ts';
import type { InstallationRecord, LockFile } from '../state/types.ts';
import { directoryChain, FileTransaction, type InstallerFileSystem } from './filesystem.ts';
import type { InstallationInspection } from './inspection.ts';
import { NoConnections } from './control.ts';
import { createInstallationRecord, metadataChanged } from './plan.ts';
import type { AgentId, InstallationChange, InstallPlan } from './types.ts';

/**
 * Применяет план под блокировкой области; FileTransaction владеет откатом и очисткой.
 *
 * @remarks Передаётся files для prepared/apply. Заимствованная целая копия обходится без workspace.
 */
export async function applyInstallPlan(
  plan: InstallPlan,
  lock: LockFile,
  state: StateTransaction,
  inspection: InstallationInspection,
  files?: FileTransaction,
  report?: (message: string) => void,
): Promise<InstallationChange> {
  const { content: prepared, snapshot, policy, force } = plan;
  const { previous, candidates } = snapshot;
  const paths = inspection.paths;
  const name = prepared.name;
  const destination = getSkillDirectory(paths, name);
  const errors = [...snapshot.errors];
  const currentHash = snapshot.contentHash;
  const download = prepared.download === undefined ? {} : { download: prepared.download };
  if (prepared.ownership === 'reuse' && plan.kind !== 'apply') {
    if ((await inspection.checkCopy(name, previous, force)) !== prepared.contentHash)
      throw new Error(
        `Установленный скилл ${name} изменился во время подготовки; повторите операцию.`,
      );
    const metadata = plan.kind === 'metadata-only';
    if (metadata)
      await state.write({ ...lock, skills: { ...lock.skills, [name]: { ...previous!, policy } } });
    return {
      name,
      status: metadata ? 'success' : 'unchanged',
      changes: { content: false, connections: false, metadata },
    };
  }
  if (!files) throw new Error('Для применения файлового плана требуется транзакция файлов.');
  if (!candidates.length) return { status: 'failed', name, errors, ...download };
  let reported = false;
  const reportReplacement = () => {
    if (previous && !reported) {
      report?.(
        `Замена ${name}; затрагиваемые агенты: ${[...new Set([...previous.agents, ...candidates.map((item) => item.agent)])].sort().join(', ')}.`,
      );
      reported = true;
    }
  };
  if (currentHash !== prepared.contentHash) reportReplacement();
  await inspection.checkParents(true);
  const finalHash = await inspection.checkCopy(name, previous, force);
  if (plan.reviewedUnchanged && finalHash !== prepared.contentHash)
    throw new Error(
      `Установленный скилл ${name} изменился во время подтверждения; повторите операцию.`,
    );
  if (prepared.ownership === 'reuse' && finalHash !== prepared.contentHash)
    throw new Error(
      `Установленный скилл ${name} изменился во время подготовки; повторите операцию.`,
    );
  const replaced = finalHash !== prepared.contentHash;
  if (replaced) {
    reportReplacement();
    if (await inspection.inspectCopy(name, previous))
      await files.move(destination, join(files.workspace, 'previous'));
    await files.move(prepared.directory, destination);
  }
  const connections = new Map(previous?.connections.map((item) => [item.agent, item]));
  let successes = 0;
  let changed = replaced;
  let connectionsChanged = false;
  for (const connection of candidates) {
    try {
      const path = resolveConnectionPath(connection.path, paths);
      const direct = samePath(path, destination);
      const existed = await inspection.inspectConnection(
        connection,
        name,
        direct || connections.has(connection.agent),
      );
      if (!existed && plan.reviewedUnchanged)
        throw new Error(
          `Подключения ${name} изменились во время подтверждения; повторите операцию.`,
        );
      if (!existed) {
        if (direct) throw new Error(`Общая копия отсутствует: ${path}.`);
        await inspection.connectionParents(path, true);
        await files.link(
          paths.scope === 'project' ? relative(dirname(path), destination) : destination,
          path,
        );
        changed = true;
        connectionsChanged = true;
      }
      if (!connections.has(connection.agent)) {
        changed = true;
        connectionsChanged = true;
      }
      connections.set(connection.agent, connection);
      successes++;
    } catch (cause) {
      errors.push(`${connection.agent}: ${errorMessage(cause)}`);
    }
  }
  if (!successes) throw new NoConnections({ status: 'failed', name, errors, ...download });
  if (!changed && !errors.length && !metadataChanged(previous, prepared, policy))
    return {
      status: 'unchanged',
      name,
      ...download,
      changes: { content: false, connections: false, metadata: false },
    };
  const record = createInstallationRecord(plan, paths, [...connections.values()]);
  const metadata = metadataChanged(previous, record, policy);
  if (changed || metadata) {
    await state.write({ ...lock, skills: { ...lock.skills, [name]: record } });
  }
  return errors.length
    ? {
        status: 'partial',
        name,
        errors,
        ...download,
        changes: { content: replaced, connections: connectionsChanged, metadata },
      }
    : {
        status: 'success',
        name,
        ...download,
        changes: { content: replaced, connections: connectionsChanged, metadata },
      };
}

/**
 * Снимает выбранные подключения и последнюю копию без хеш-проверки ручных правок.
 *
 * @remarks Вызывается внутри StateTransaction; ошибки отдельных подключений дают partial.
 */
export async function applyRemoval(
  record: InstallationRecord,
  lock: LockFile,
  requested: readonly AgentId[],
  state: StateTransaction,
  inspection: InstallationInspection,
  fs: InstallerFileSystem,
): Promise<InstallationChange> {
  const paths = inspection.paths;
  const name = record.name;
  await inspection.checkParents();
  await inspection.inspectCopy(name, record);
  await directoryChain(paths.scope === 'project' ? paths.cwd : paths.home, ['.agents'], fs, true);
  return FileTransaction.run(
    paths.agentsDirectory,
    fs,
    async (files): Promise<InstallationChange> => {
      const removed: AgentId[] = [];
      const errors: string[] = [];
      for (const agent of requested) {
        try {
          const connection = record.connections.find((item) => item.agent === agent);
          if (connection && (await inspection.inspectConnection(connection, name, true))) {
            const path = resolveConnectionPath(connection.path, paths);
            if (!samePath(path, getSkillDirectory(paths, name)))
              await files.move(path, join(files.workspace, `connection-${agent}`));
          }
          removed.push(agent);
        } catch (cause) {
          errors.push(`${agent}: ${errorMessage(cause)}`);
        }
      }
      if (!removed.length) return { status: 'failed', name, errors };
      const remaining = record.agents.filter((agent) => !removed.includes(agent));
      const skills = { ...lock.skills };
      if (remaining.length)
        skills[name] = {
          ...record,
          agents: remaining,
          connections: record.connections.filter((item) => !removed.includes(item.agent)),
        };
      else {
        await inspection.checkParents();
        if (await inspection.inspectCopy(name, record))
          await files.move(getSkillDirectory(paths, name), join(files.workspace, 'previous'));
        delete skills[name];
      }
      await state.write({ ...lock, skills });
      return errors.length ? { status: 'partial', name, errors } : { status: 'success', name };
    },
  );
}
