import type { AgentId, ConnectionKind } from '@/agents';

export const LOCK_VERSION = 1;

export interface ManagedConnection {
  readonly agent: AgentId;
  readonly kind: ConnectionKind;
  /** Управляемое назначение; проектный путь относителен к cwd. */
  readonly path: string;
}

/** Имена компонента в API и каталога установки могут различаться. */
export interface InstalledSkill {
  readonly name: string;
  readonly installName: string;
  readonly contentHash: string;
  readonly archiveHash: string;
  readonly connections: readonly ManagedConnection[];
}

/** Версия одна для всех установленных скиллов пакета в выбранной области. */
export interface InstalledPackage {
  readonly slug: string;
  readonly registryUrl: string;
  readonly version: string;
  readonly skills: readonly InstalledSkill[];
}

export interface LockFile {
  readonly version: typeof LOCK_VERSION;
  readonly packages: readonly InstalledPackage[];
}

/** Возвращает пустой lock текущей версии без I/O. */
export function createEmptyLock(): LockFile {
  return { version: LOCK_VERSION, packages: [] };
}
