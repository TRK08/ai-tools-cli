import { hasErrorCode } from '@/errors';
import type { RuntimeContext } from '@/runtime';
import { agentConnectionKind, agentSkillsDirectory, type AgentId } from '@/agents';
import {
  WORKSPACE_PREFIX,
  hashDirectory,
  getSkillDirectory,
  portableConnectionPath,
  resolveConnectionPath,
  type StatePaths,
  type InstalledSkill,
  type ManagedConnection,
} from '@/state';
import { isPathWithin, nativePath, relativePathParts, samePath } from '@/paths';
import { directoryChain, inspectPath, type InstallerFileSystem } from './filesystem';
import type { PathSnapshot, SkillSnapshot } from './types';

/** Проверяет объекты и управляемые пути без изменения установки. */
export class InstallationInspection {
  /** Связывает область, окружение агентов и подменяемый файловый I/O. */
  constructor(
    private readonly context: RuntimeContext,
    readonly paths: StatePaths,
    private readonly fs: InstallerFileSystem,
  ) {}

  /** Проверяет или создаёт родителей общего каталога без прохождения через ссылки. */
  async sharedParents(create = false): Promise<void> {
    await directoryChain(this.base, ['.agents', 'skills'], this.fs, create);
  }

  /** Создаёт только родителя workspace, проверив, что он обычный каталог. */
  async workspaceParent(): Promise<void> {
    await directoryChain(this.base, ['.agents'], this.fs, true);
    const leftovers = (await this.fs.readdir(this.paths.agentsDirectory)).filter((name) =>
      name.startsWith(WORKSPACE_PREFIX),
    );
    if (leftovers.length)
      throw new Error(
        `Остались каталоги восстановления: ${leftovers.map((name) => nativePath.join(this.paths.agentsDirectory, name)).join(', ')}. Проверьте их вручную.`,
      );
  }

  private get base(): string {
    return this.paths.scope === 'project' ? this.paths.cwd : this.paths.home;
  }

  /** Проверяет или создаёт родителей подключения, включая env-путь Claude вне home. */
  async connectionParents(path: string, create = false): Promise<void> {
    const parent = nativePath.dirname(path);
    const root = this.paths.scope === 'project' ? this.paths.cwd : nativePath.parse(parent).root;
    await directoryChain(root, relativePathParts(root, parent), this.fs, create);
  }

  /** Сохраняет путь уже подключённого агента либо вычисляет новое назначение. */
  connection(installName: string, agent: AgentId, previous?: InstalledSkill): ManagedConnection {
    const saved = previous?.connections.find((item) => item.agent === agent);
    if (saved) return saved;
    const kind = agentConnectionKind(agent, this.paths.scope);
    const target = nativePath.join(
      agentSkillsDirectory(this.context, this.paths.scope, agent),
      installName,
    );
    if (kind !== 'direct' && isPathWithin(this.paths.skillsDirectory, target))
      throw new Error(`Путь агента пересекается с общим каталогом скиллов: ${target}.`);
    return { agent, kind, path: portableConnectionPath(target, this.paths) };
  }

  /** Снимает inode и хеш общей копии. Существующий неуправляемый объект отклоняется. */
  async shared(
    installName: string,
    owned: boolean,
    signal?: AbortSignal,
  ): Promise<PathSnapshot | null> {
    await this.sharedParents();
    const path = getSkillDirectory(this.paths, installName);
    return this.directory(path, owned, signal);
  }

  /** Проверяет цель ссылки и запоминает физическое состояние для повторной сверки. */
  async destination(
    connection: ManagedConnection,
    installName: string,
    owned: boolean,
    signal?: AbortSignal,
  ): Promise<PathSnapshot | null> {
    signal?.throwIfAborted();
    const path = resolveConnectionPath(connection.path, this.paths);
    await this.connectionParents(path);
    const stats = await inspectPath(path, this.fs);
    if (!stats) return null;
    const target = stats.isSymbolicLink() ? await this.fs.readlink(path) : '';
    if (
      !owned ||
      !stats.isSymbolicLink() ||
      (this.paths.scope === 'project' && nativePath.isAbsolute(target)) ||
      !samePath(
        nativePath.resolve(nativePath.dirname(path), target),
        getSkillDirectory(this.paths, installName),
      )
    )
      throw new Error(`Путь агента занят чужим объектом: ${path}.`);
    return { identity: `${stats.dev}/${stats.ino}` };
  }

  /** Собирает состояние общей копии и физических подключений до подтверждения и применения. */
  async snapshot(
    installName: string,
    previous: InstalledSkill | undefined,
    connections: readonly ManagedConnection[],
    signal?: AbortSignal,
  ): Promise<SkillSnapshot> {
    const shared = await this.shared(installName, previous !== undefined, signal);
    const destinations: SkillSnapshot['destinations'][number][] = [];
    const physical = new Map(
      [...(previous?.connections ?? []), ...connections]
        .filter((item) => item.kind !== 'direct')
        .map((item) => [item.agent, item]),
    );
    for (const connection of physical.values()) {
      signal?.throwIfAborted();
      const owned = previous?.connections.some((item) => item.agent === connection.agent) ?? false;
      destinations.push({
        connection,
        snapshot: await this.destination(connection, installName, owned, signal),
      });
    }
    return { shared, destinations };
  }

  /** Хеширует управляемый каталог. При небезопасном или нечитаемом дереве прекращает операцию. */
  private async directory(
    path: string,
    owned: boolean,
    signal?: AbortSignal,
  ): Promise<PathSnapshot | null> {
    const stats = await inspectPath(path, this.fs);
    if (!stats) return null;
    if (!owned || !stats.isDirectory() || stats.isSymbolicLink())
      throw new Error(`Каталог занят чужим объектом: ${path}.`);
    return {
      identity: `${stats.dev}/${stats.ino}`,
      contentHash: await hashDirectory(path, { signal }).catch((cause: unknown) => {
        if (!hasErrorCode(cause, 'INVALID_PATH')) throw cause;
        // Ручная правка может добавить допустимое на POSIX, но непереносимое имя.
        return hashDirectory(path, { signal, portableNames: false });
      }),
    };
  }
}
