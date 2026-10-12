import type { AgentId } from '../installer/types.ts';
import type { SourceIdentity } from '../sources/types.ts';

export const LOCK_VERSION = 1;

export interface ManagedConnection {
  readonly agent: AgentId;
  /** Relative to cwd in a project record; absolute in a global record. */
  readonly path: string;
}

/** Paths are portable in a project lock and absolute in a global lock. */
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

export function createEmptyLock(): LockFile {
  return { version: LOCK_VERSION, skills: {} };
}
