import type { AgentId } from '../installer/types.ts';
import type { SourceIdentity } from '../sources/types.ts';

export interface ManagedConnection {
  readonly agent: AgentId;
  /** Relative to cwd in a project record; absolute in a global record. */
  readonly path: string;
}

/** Internal model only. Lock serialization and schema validation belong to task 002. */
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
