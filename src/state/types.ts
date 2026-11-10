import type { AgentId, ConnectionKind } from '@/agents';
import type { SourceIdentity } from '@/sources/types';

export const LOCK_VERSION = 1;

export interface ManagedConnection {
  readonly agent: AgentId;
  /** Вид подключения сверяется с единым каталогом агентов для выбранной области. */
  readonly kind: ConnectionKind;
  /** Управляемое назначение; проектный путь относителен к cwd. */
  readonly path: string;
}

/** Пути переносимы в проектном lock и абсолютны в глобальном. */
export interface InstallationRecord {
  readonly name: string;
  readonly source: SourceIdentity;
  readonly version: string | null;
  readonly policy: 'local' | 'latest' | 'exact';
  readonly contentHash: string;
  readonly archiveHash?: string;
  readonly agents: readonly AgentId[];
  readonly connections: readonly ManagedConnection[];
}

export interface LockFile {
  readonly version: typeof LOCK_VERSION;
  readonly skills: Readonly<Record<string, InstallationRecord>>;
}

/** Возвращает пустой lock текущей версии схемы; файлы и каталоги не создаёт. */
export function createEmptyLock(): LockFile {
  return { version: LOCK_VERSION, skills: {} };
}
