import { errorMessage } from '../errors.ts';
import { dirname, join, parse, relative, resolve } from 'node:path';
import { isCancellation } from '../cancellation.ts';
import type { RuntimeContext } from '../runtime.ts';
import { isDirectAgent } from '../agents/catalog.ts';
import { hashDirectory } from '../state/hash.ts';
import {
  getSkillDirectory,
  portableConnectionPath,
  resolveConnectionPath,
  type StatePaths,
} from '../state/paths.ts';
import type { InstallationRecord, ManagedConnection } from '../state/types.ts';
import { agentSkillsDirectory } from './agents.ts';
import { directoryChain, inspectPath, type InstallerFileSystem } from './filesystem.ts';
import type { AgentId, InstalledSnapshot } from './types.ts';

/** Проверки файловых объектов и управляемых путей с подменяемым I/O. */
export class InstallationInspection {
  /** Связывает пути области, окружение агентов и подменяемый I/O для последующих проверок. */
  constructor(
    private readonly context: RuntimeContext,
    readonly paths: StatePaths,
    private readonly fs: InstallerFileSystem,
  ) {}

  /** Проверяет соответствие сохранённых подключений правилам агентов и области. */
  assertSupported(record: InstallationRecord): void {
    for (const connection of record.connections) {
      const path = resolveConnectionPath(connection.path, this.paths);
      const shared = getSkillDirectory(this.paths, record.name);
      const direct = isDirectAgent(connection.agent, this.paths.scope);
      if (
        (direct && path !== shared) ||
        (!direct && path === shared) ||
        (this.paths.scope === 'project' &&
          path !==
            join(agentSkillsDirectory(this.context, 'project', connection.agent), record.name))
      )
        throw new Error(`Некорректное управляемое подключение для ${connection.agent}: ${path}.`);
    }
  }

  /** Проверяет родителей общей копии; create разрешает создать отсутствующие каталоги. */
  async checkParents(create = false): Promise<void> {
    await directoryChain(
      this.paths.scope === 'project' ? this.paths.cwd : this.paths.home,
      ['.agents', 'skills'],
      this.fs,
      create,
    );
  }

  /** Проверяет каждый родитель пути агента, включая env-пути вне home. */
  async connectionParents(path: string, create = false): Promise<void> {
    // Для env-пути вне home проверяем каждый родитель до мутаций.
    const parent = dirname(path);
    const root = this.paths.scope === 'project' ? this.paths.cwd : parse(parent).root;
    await directoryChain(root, relative(root, parent).split('/').filter(Boolean), this.fs, create);
  }

  /** Проверяет наличие управляемого обычного каталога; чужие объекты отклоняет. */
  async inspectCopy(name: string, record?: InstallationRecord): Promise<boolean> {
    const path = getSkillDirectory(this.paths, name);
    const stats = await inspectPath(path, this.fs);
    if (!stats) return false;
    if (!record || !stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Общий каталог занят чужим объектом: ${path}.`);
    }
    return true;
  }

  /** Проверяет хеш и защиту ручных правок; force не поглощает отмену. */
  async checkCopy(
    name: string,
    record: InstallationRecord | undefined,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!(await this.inspectCopy(name, record))) return null;
    const path = getSkillDirectory(this.paths, name);
    let contentHash: string;
    try {
      contentHash = await hashDirectory(path, { signal });
    } catch (cause) {
      if (isCancellation(cause, signal)) throw cause;
      if (force) return null;
      throw new Error(
        `Не удалось проверить установленный скилл ${name}; используйте --force для замены его содержимого.`,
        {
          cause,
        },
      );
    }
    if (!force && contentHash !== record!.contentHash) {
      throw new Error(
        `Установленный скилл ${name} изменён локально; используйте --force для замены его содержимого.`,
      );
    }
    return contentHash;
  }

  /** Возвращает сохранённый путь или вычисляет новый; запрещает пересечения. */
  connection(name: string, agent: AgentId, previous?: InstallationRecord): ManagedConnection {
    const connection = previous?.connections.find((item) => item.agent === agent) ?? {
      agent,
      path: portableConnectionPath(
        join(agentSkillsDirectory(this.context, this.paths.scope, agent), name),
        this.paths,
      ),
    };
    const path = resolveConnectionPath(connection.path, this.paths);
    const directAgent = isDirectAgent(agent, this.paths.scope);
    const withinShared = relative(this.paths.skillsDirectory, path);
    if (!directAgent && !withinShared.startsWith('../') && withinShared !== '..') {
      throw new Error(`Путь агента пересекается с общим хранилищем скиллов: ${path}.`);
    }
    return connection;
  }

  /** Проверяет владение каталогом или ссылкой и её цель без изменения файлов. */
  async inspectConnection(
    connection: ManagedConnection,
    name: string,
    owned: boolean,
  ): Promise<boolean> {
    const path = resolveConnectionPath(connection.path, this.paths);
    await this.connectionParents(path);
    const stats = await inspectPath(path, this.fs);
    if (!stats) return false;
    const shared = getSkillDirectory(this.paths, name);
    if (path === shared) {
      if (!owned || !stats.isDirectory() || stats.isSymbolicLink())
        throw new Error(`Общий каталог занят чужим объектом: ${path}.`);
    } else if (
      !owned ||
      !stats.isSymbolicLink() ||
      resolve(dirname(path), await this.fs.readlink(path)) !== shared
    ) {
      throw new Error(`Путь агента занят чужим объектом: ${path}.`);
    }
    return true;
  }

  /** Определяет необходимость восстановления управляемых подключений. */
  async connectionsNeedRepair(record: InstallationRecord): Promise<boolean> {
    for (const connection of record.connections) {
      try {
        if (!(await this.inspectConnection(connection, record.name, true))) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  /** Проверяет только ранее зарегистрированные назначения для быстрого повторного add/update. */
  async reusableSnapshot(
    record: InstallationRecord,
    requested: readonly AgentId[],
    contentHash: string | null,
  ): Promise<InstalledSnapshot> {
    let intact = true;
    const candidates: ManagedConnection[] = [];
    for (const agent of requested) {
      const connection = record.connections.find((item) => item.agent === agent);
      try {
        if (!connection || !(await this.inspectConnection(connection, record.name, true)))
          intact = false;
      } catch {
        intact = false;
      }
      if (connection) candidates.push(connection);
    }
    return {
      previous: record,
      contentHash,
      candidates,
      errors: [],
      connectionsNeedRepair: !intact,
    };
  }

  /** Собирает допустимые подключения и ошибки до изменения копии; не создаёт назначений. */
  async snapshot(
    name: string,
    previous: InstallationRecord | undefined,
    force: boolean,
    requested: readonly AgentId[],
  ): Promise<InstalledSnapshot> {
    await this.checkParents();
    const contentHash = await this.checkCopy(name, previous, force);
    const destination = getSkillDirectory(this.paths, name);
    const candidates: ManagedConnection[] = [];
    const errors: string[] = [];
    let connectionsNeedRepair = false;
    for (const agent of requested) {
      try {
        const connection = this.connection(name, agent, previous);
        const exists = await this.inspectConnection(
          connection,
          name,
          !!previous?.connections.some((item) => item.agent === agent) ||
            (resolveConnectionPath(connection.path, this.paths) === destination && !!previous),
        );
        if (!exists) connectionsNeedRepair = true;
        candidates.push(connection);
      } catch (cause) {
        errors.push(`${agent}: ${errorMessage(cause)}`);
      }
    }
    return { previous, contentHash, candidates, errors, connectionsNeedRepair };
  }
}
