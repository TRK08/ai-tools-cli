import { errorMessage } from '../errors.ts';
import { isCancellation } from '../cancellation.ts';
import type { RuntimeContext } from '../runtime.ts';
import { agentConnectionKind, isDirectAgent } from '../agents/catalog.ts';
import { hashDirectory } from '../state/hash.ts';
import {
  getSkillDirectory,
  portableConnectionPath,
  resolveConnectionPath,
  type StatePaths,
} from '../state/paths.ts';
import type { InstallationRecord, ManagedConnection } from '../state/types.ts';
import { isPathWithin, nativePath, relativePathParts, samePath } from '../state/native-path.ts';
import { agentSkillsDirectory } from '../agents/resolve.ts';
import { directoryChain, inspectPath, type InstallerFileSystem } from './filesystem.ts';
import type { AgentId } from '../agents/catalog.ts';
import type { InstalledCopy, InstalledSnapshot } from './types.ts';

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
    const { join } = nativePath;
    for (const connection of record.connections) {
      const path = resolveConnectionPath(connection.path, this.paths);
      const shared = getSkillDirectory(this.paths, record.name);
      const direct = isDirectAgent(connection.agent, this.paths.scope);
      if (
        (direct && !samePath(path, shared)) ||
        (!direct && samePath(path, shared)) ||
        (this.paths.scope === 'project' &&
          !samePath(
            path,
            join(agentSkillsDirectory(this.context, 'project', connection.agent), record.name),
          ))
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
    const { dirname, parse } = nativePath;
    // Для env-пути вне home проверяем каждый родитель до мутаций.
    const parent = dirname(path);
    const root = this.paths.scope === 'project' ? this.paths.cwd : parse(parent).root;
    await directoryChain(root, relativePathParts(root, parent), this.fs, create);
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

  /** Сверяет физическую копию с общим эталоном; force разрешает только замену её содержимого. */
  private async hashCopy(
    path: string,
    name: string,
    record: InstallationRecord,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<string | null> {
    let contentHash: string;
    try {
      contentHash = await hashDirectory(path, {
        signal,
        portableNames: this.paths.scope === 'project',
      });
    } catch (cause) {
      if (isCancellation(cause, signal) || signal?.aborted) throw cause;
      if (force) return null;
      throw new Error(
        `Не удалось проверить установленный скилл ${name}; используйте --force для замены его содержимого.`,
        {
          cause,
        },
      );
    }
    if (!force && contentHash !== record.contentHash) {
      throw new Error(
        `Установленный скилл ${name} изменён локально; используйте --force для замены его содержимого.`,
      );
    }
    return contentHash;
  }

  /** Возвращает сохранённый путь или вычисляет новый; запрещает пересечения. */
  connection(name: string, agent: AgentId, previous?: InstallationRecord): ManagedConnection {
    const { join } = nativePath;
    const connection = previous?.connections.find((item) => item.agent === agent) ?? {
      agent,
      kind: agentConnectionKind(agent, this.paths.scope),
      path: portableConnectionPath(
        join(agentSkillsDirectory(this.context, this.paths.scope, agent), name),
        this.paths,
      ),
    };
    const path = resolveConnectionPath(connection.path, this.paths);
    const directAgent = isDirectAgent(agent, this.paths.scope);
    if (!directAgent && isPathWithin(this.paths.skillsDirectory, path)) {
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
    const { resolve, dirname } = nativePath;
    const path = resolveConnectionPath(connection.path, this.paths);
    await this.connectionParents(path);
    const stats = await inspectPath(path, this.fs);
    if (!stats) return false;
    const shared = getSkillDirectory(this.paths, name);
    if (samePath(path, shared)) {
      if (!owned || !stats.isDirectory() || stats.isSymbolicLink())
        throw new Error(`Общий каталог занят чужим объектом: ${path}.`);
    } else if (connection.kind === 'copy') {
      if (!owned || !stats.isDirectory() || stats.isSymbolicLink())
        throw new Error(`Путь агента занят чужим объектом: ${path}.`);
    } else if (
      !owned ||
      !stats.isSymbolicLink() ||
      !samePath(resolve(dirname(path), await this.fs.readlink(path)), shared)
    ) {
      throw new Error(`Путь агента занят чужим объектом: ${path}.`);
    }
    return true;
  }

  /** Проверяет каталог copy-агента, родителей и общий эталон; отмена не подавляется force. */
  async connectionCopy(
    connection: ManagedConnection,
    record: InstallationRecord,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<InstalledCopy> {
    const exists = await this.inspectConnection(connection, record.name, true);
    const path = resolveConnectionPath(connection.path, this.paths);
    return {
      path,
      owned: true,
      exists,
      contentHash: exists ? await this.hashCopy(path, record.name, record, force, signal) : null,
    };
  }

  /** Проверяет все физические копии независимо от фильтра агентов. */
  private async copies(
    name: string,
    previous: InstallationRecord | undefined,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<InstalledCopy[]> {
    await this.checkParents();
    const path = getSkillDirectory(this.paths, name);
    const exists = await this.inspectCopy(name, previous);
    const copies: InstalledCopy[] = [
      {
        path,
        owned: !!previous,
        exists,
        contentHash: exists ? await this.hashCopy(path, name, previous!, force, signal) : null,
      },
    ];
    for (const connection of previous?.connections ?? []) {
      signal?.throwIfAborted();
      if (connection.kind === 'copy')
        copies.push(await this.connectionCopy(connection, previous!, force, signal));
    }
    return copies;
  }

  /** Собирает все прежние назначения и допустимые новые; ошибка прежнего объекта фатальна. */
  async snapshot(
    name: string,
    previous: InstallationRecord | undefined,
    force: boolean,
    requested: readonly AgentId[],
    signal?: AbortSignal,
  ): Promise<InstalledSnapshot> {
    const copies = await this.copies(name, previous, force, signal);
    const candidates: ManagedConnection[] = [];
    const errors: string[] = [];
    const destinations: InstalledSnapshot['destinations'][number][] = [];
    for (const agent of new Set([
      ...(previous?.connections.map((item) => item.agent) ?? []),
      ...requested,
    ])) {
      signal?.throwIfAborted();
      const owned = !!previous?.connections.some((item) => item.agent === agent);
      try {
        const connection = this.connection(name, agent, previous);
        const exists = await this.inspectConnection(
          connection,
          name,
          owned || (connection.kind === 'direct' && !!previous),
        );
        destinations.push({ connection, exists });
        if (requested.includes(agent)) candidates.push(connection);
      } catch (cause) {
        if (owned || isCancellation(cause, signal) || signal?.aborted) throw cause;
        errors.push(`${agent}: ${errorMessage(cause)}`);
      }
    }
    return {
      previous,
      contentHash: copies[0]!.contentHash,
      copies,
      destinations,
      candidates,
      errors,
      connectionsNeedRepair: destinations.some((item) => !item.exists),
    };
  }

  /** Повторяет проверки перед мутациями; гонка после preview отменяет весь план, включая force/reuse. */
  async assertUnchanged(
    name: string,
    snapshot: InstalledSnapshot,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = await this.snapshot(
      name,
      snapshot.previous,
      force,
      snapshot.candidates.map((item) => item.agent),
      signal,
    );
    if (
      current.errors.length ||
      JSON.stringify(current.copies) !== JSON.stringify(snapshot.copies) ||
      JSON.stringify(current.destinations) !== JSON.stringify(snapshot.destinations)
    ) {
      throw new Error(
        `Установленный скилл ${name} изменился во время подготовки или подтверждения (содержимое или подключения); повторите операцию.`,
      );
    }
  }
}
