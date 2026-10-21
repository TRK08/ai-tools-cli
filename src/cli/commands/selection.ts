import { AGENTS, agentSkillsDirectory, parseAgents } from '../../installer/agents.ts';
import { isDirectAgent } from '../../agents/catalog.ts';
import { getStatePaths } from '../../state/paths.ts';
import type { AgentId } from '../../installer/types.ts';
import type { InstallationScope, RuntimeContext } from '../../runtime.ts';
import type { PromptStreams } from '../terminal/types.ts';
import { scopeLabel } from '../ui/labels.ts';
import { selectAgentChoices } from '../ui/agents-prompt.ts';
import { selectAddScope } from '../ui/add-confirm.ts';

/** Выбирает область add/find; -g и отсутствие пары TTY обходят меню, отмена возвращает null. */
export async function selectScope(
  global: boolean | undefined,
  context: RuntimeContext,
  streams: PromptStreams,
): Promise<InstallationScope | null> {
  if (global) return 'global';
  if (!streams.input.isTTY || !streams.output.isTTY) return 'project';
  return selectAddScope({ project: context.roots.cwd, global: context.roots.home }, streams);
}

/** Проверяет явных агентов либо готовит меню; без списка и TTY бросает ошибку до чтения источника. */
export async function selectAgents(
  explicit: readonly string[],
  context: RuntimeContext,
  scope: InstallationScope,
  streams: PromptStreams,
): Promise<AgentId[] | null> {
  const agents = parseAgents(explicit);
  if (agents.length)
    return AGENTS.filter((agent) => agents.includes(agent.id)).map((agent) => agent.id);
  if (!streams.input.isTTY || !streams.output.isTTY)
    throw new Error(
      'Для выбора агентов нужны stdin и stdout терминала (TTY); укажите -a <agent> (например, -a codex).',
    );
  const choices = AGENTS.map((agent) => ({
    value: agent.id,
    label: agent.label,
    hint: agentSkillsDirectory(context, scope, agent.id),
  }));

  const selected = await selectAgentChoices(
    {
      scope: scopeLabel(scope),
      sharedDirectory: getStatePaths(context.roots, scope).skillsDirectory,
      locked: choices.filter((agent) => isDirectAgent(agent.value, scope)),
      options: choices.filter((agent) => !isDirectAgent(agent.value, scope)),
    },
    streams,
  );
  return selected === null
    ? null
    : AGENTS.filter((agent) => selected.includes(agent.id)).map((agent) => agent.id);
}
