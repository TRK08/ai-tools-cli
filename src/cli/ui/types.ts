import type { RegistryFindSearch } from '@/cli/find-search';
import type { AgentId } from '@/agents';
import type { Choice } from '@/cli/terminal';

/** Готовая карточка: источник и область подписаны, назначения объединены по пути. */
export interface AddCardView {
  readonly name: string;
  readonly installationName: string;
  readonly slug?: string;
  readonly version: string | null;
  readonly source: string;
  readonly scope: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly installCount?: number;
  readonly sharedDirectory: string;
  readonly destinations: readonly { readonly path: string; readonly agents: readonly string[] }[];
}

export interface AgentsView {
  readonly scope: string;
  readonly sharedDirectory: string;
  readonly locked: readonly Choice<AgentId>[];
  readonly options: readonly Choice<AgentId>[];
}

/** Сценарий создаёт поисковую модель; экран подписывается на изменения и владеет её закрытием. */
export type FindSearchFactory = (changed: () => void) => RegistryFindSearch;
