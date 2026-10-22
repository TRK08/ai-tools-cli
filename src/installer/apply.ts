import { join } from 'node:path';
import {
  hashDirectory,
  getSkillDirectory,
  resolveConnectionPath,
  type StateTransaction,
  type InstallationRecord,
  type LockFile,
} from '@/state';
import { errorMessage } from '@/errors';
import { samePath } from '@/paths';
import { directoryChain, FileTransaction, type InstallerFileSystem } from './filesystem';
import type { InstallationInspection } from './inspection';
import { NoConnections } from './control';
import { createInstallationRecord, metadataChanged } from './plan';
import type { AgentId } from '@/agents';
import type { InstallationChange, InstallPlan } from './types';

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
  const download = prepared.download === undefined ? {} : { download: prepared.download };
  await inspection.assertUnchanged(name, snapshot, force);
  if (!candidates.length) return { status: 'failed', name, errors, ...download };
  if (plan.kind !== 'apply') {
    const metadata = plan.kind === 'metadata-only';
    if (metadata) {
      const record = createInstallationRecord(plan, paths, previous!.connections);
      await state.write({ ...lock, skills: { ...lock.skills, [name]: record } });
    }
    return {
      name,
      status: metadata ? 'success' : 'unchanged',
      ...download,
      changes: { content: false, connections: false, metadata },
    };
  }
  if (!files) throw new Error('Для применения файлового плана требуется транзакция файлов.');
  const allConnections = new Map([
    ...(previous?.connections ?? []).map((item) => [item.agent, item] as const),
    ...candidates.map((item) => [item.agent, item] as const),
  ]);
  const staged = new Map<AgentId, string>();
  const rejected = new Set<AgentId>();
  // Снимок ещё не перемещён: все copy-назначения получают одни и те же проверенные bytes.
  for (const connection of allConnections.values()) {
    if (connection.kind !== 'copy') continue;
    const path = resolveConnectionPath(connection.path, paths);
    if (
      snapshot.copies.some(
        (copy) => samePath(copy.path, path) && copy.contentHash === prepared.contentHash,
      )
    )
      continue;
    try {
      const staging = await files.stageCopy(prepared.directory, connection.agent);
      if (
        (await hashDirectory(staging, { portableNames: paths.scope === 'project' })) !==
        prepared.contentHash
      )
        throw new Error(`Хеш подготовленной копии ${name} не совпадает со снимком.`);
      staged.set(connection.agent, staging);
    } catch (cause) {
      if (previous?.connections.some((item) => item.agent === connection.agent)) throw cause;
      rejected.add(connection.agent);
      errors.push(`${connection.agent}: ${errorMessage(cause)}`);
    }
  }
  if (candidates.every((item) => rejected.has(item.agent)))
    throw new NoConnections({ status: 'failed', name, errors, ...download });
  await inspection.checkParents(true);
  const replaced = snapshot.contentHash !== prepared.contentHash;
  if (replaced && prepared.ownership === 'reuse')
    throw new Error(`Заимствованная общая копия ${name} не может быть заменена.`);
  if (previous && (replaced || staged.size))
    report?.(
      `Замена ${name}; затрагиваемые агенты: ${[...new Set([...previous.agents, ...candidates.map((item) => item.agent)])].sort().join(', ')}.`,
    );
  await inspection.assertUnchanged(name, snapshot, force);
  if (replaced) {
    if (await inspection.inspectCopy(name, previous))
      await files.move(destination, join(files.workspace, 'previous'));
    await files.move(prepared.directory, destination);
  }
  const connections = new Map(previous?.connections.map((item) => [item.agent, item]));
  let successes = 0;
  let contentChanged = replaced;
  let connectionsChanged = false;
  for (const connection of allConnections.values()) {
    if (rejected.has(connection.agent)) continue;
    const owned = connections.has(connection.agent);
    try {
      const path = resolveConnectionPath(connection.path, paths);
      const existed = await inspection.inspectConnection(
        connection,
        name,
        connection.kind === 'direct' || owned,
      );
      if (connection.kind === 'copy' && staged.has(connection.agent)) {
        // Повторная проверка конкретной копии непосредственно перед её заменой.
        if (owned) {
          const current = await inspection.connectionCopy(connection, previous!, force);
          const before = snapshot.copies.find((copy) => samePath(copy.path, path));
          if (
            !before ||
            current.exists !== before.exists ||
            current.contentHash !== before.contentHash
          )
            throw new Error(`Копия ${name} изменилась во время применения; повторите операцию.`);
        }
        await inspection.connectionParents(path, true);
        if (existed) await files.move(path, join(files.workspace, `previous-${connection.agent}`));
        await files.move(staged.get(connection.agent)!, path);
        if (owned) contentChanged = true;
      } else if (!existed) {
        if (connection.kind === 'direct') throw new Error(`Общая копия отсутствует: ${path}.`);
        if (connection.kind === 'copy') throw new Error(`Копия агента отсутствует: ${path}.`);
        await inspection.connectionParents(path, true);
        await files.link(destination, path);
      }
      if (!existed || !owned) connectionsChanged = true;
      connections.set(connection.agent, connection);
      if (candidates.some((item) => item.agent === connection.agent)) successes++;
    } catch (cause) {
      // Прежние назначения обязаны перейти на одну версию вместе с общей копией.
      if (owned) throw cause;
      errors.push(`${connection.agent}: ${errorMessage(cause)}`);
    }
  }
  if (!successes) throw new NoConnections({ status: 'failed', name, errors, ...download });
  const record = createInstallationRecord(plan, paths, [...connections.values()]);
  const metadata = metadataChanged(previous, record, policy);
  if (contentChanged || connectionsChanged || metadata)
    await state.write({ ...lock, skills: { ...lock.skills, [name]: record } });
  const changes = { content: contentChanged, connections: connectionsChanged, metadata };
  return errors.length
    ? { status: 'partial', name, errors, ...download, changes }
    : {
        status: contentChanged || connectionsChanged || metadata ? 'success' : 'unchanged',
        name,
        ...download,
        changes,
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
            if (connection.kind === 'link')
              await files.unlink(path, getSkillDirectory(paths, name));
            else if (connection.kind === 'copy')
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
