import type { Readable, Writable } from 'node:stream';
import { AGENTS, agentSkillsDirectory, parseAgents } from '../installer/agents.ts';
import type { AgentId, InstallationScope } from '../installer/types.ts';
import type { RuntimeContext } from '../runtime.ts';
import { searchMultiselect } from './search-multiselect.ts';
import { isDirectAgent } from '../agents/catalog.ts';
import { getStatePaths } from '../state/paths.ts';
import { scopeLabel } from './labels.ts';

export interface PromptStreams {
  readonly input: Readable & {
    readonly isTTY?: boolean;
    readonly isRaw?: boolean;
    readonly setRawMode?: (value: boolean) => void;
  };
  readonly output: Writable & {
    readonly isTTY?: boolean;
    readonly columns?: number;
    readonly rows?: number;
  };
}

/**
 * Проверяет явный список либо открывает поиск с закреплёнными агентами общей папки.
 *
 * @returns Выбранные агенты без повторов в порядке каталога либо null при отмене.
 * @throws Error — если явного списка нет и stdin/stdout не являются TTY.
 */
export async function selectAgents(
  explicit: readonly string[],
  context: RuntimeContext,
  scope: InstallationScope,
  streams: PromptStreams,
): Promise<AgentId[] | null> {
  const agents = parseAgents(explicit);
  if (agents.length)
    return AGENTS.filter((agent) => agents.includes(agent.id)).map((agent) => agent.id);
  if (!streams.input.isTTY || !streams.output.isTTY) {
    throw new Error(
      'Для выбора агентов нужны stdin и stdout терминала (TTY); укажите -a <agent> (например, -a codex).',
    );
  }
  const choices = AGENTS.map((agent) => ({
    value: agent.id,
    label: agent.label,
    hint: agentSkillsDirectory(context, scope, agent.id),
  }));
  const selected = await searchMultiselect<AgentId>({
    message: `Выберите агентов (${scopeLabel(scope)})`,
    sharedDirectory: getStatePaths(context.roots, scope).skillsDirectory,
    locked: choices.filter((agent) => isDirectAgent(agent.value, scope)),
    options: choices.filter((agent) => !isDirectAgent(agent.value, scope)),
    input: streams.input,
    output: streams.output,
  });
  return selected === null
    ? null
    : AGENTS.filter((agent) => selected.includes(agent.id)).map((agent) => agent.id);
}
