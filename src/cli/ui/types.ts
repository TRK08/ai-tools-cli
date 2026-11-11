import type { AgentId } from '@/agents';
import type { Choice } from '@/cli/terminal';
import type { RegistryFindSearch } from '@/cli/find-search';

export interface AgentsView {
  readonly scope: string;
  readonly sharedDirectory: string;
  readonly locked: readonly Choice<AgentId>[];
  readonly options: readonly Choice<AgentId>[];
}

export type FindSearchFactory = (changed: () => void) => RegistryFindSearch;
