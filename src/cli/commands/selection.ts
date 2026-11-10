import { AGENTS, isDirectAgent, agentSkillsDirectory, type AgentId } from '@/agents';
import { getStatePaths } from '@/state';
import type { InstallationScope, RuntimeContext } from '@/runtime';
import type { PromptStreams } from '@/cli/terminal';
import { scopeLabel } from '@/cli/ui/labels';
import { selectAgentChoices } from '@/cli/ui/agents-prompt';
import { selectAddScope } from '@/cli/ui/add-confirm';
import { scopeOf } from '@/cli/context';
import type { ScopeOptions } from '@/cli/types';

/** Проверяет пару TTY. Изменяющим командам без неё нужен явный --yes. */
export function requireMutationTty(streams: PromptStreams, yes?: boolean): void {
  if (!yes && (!streams.input.isTTY || !streams.output.isTTY))
    throw new Error('Для изменения установок без TTY укажите --yes.');
}

/** Выбирает область. Явный флаг, --yes и отсутствие пары TTY обходят меню. */
export async function selectScope(
  options: ScopeOptions & { readonly yes?: boolean },
  context: RuntimeContext,
  streams: PromptStreams,
): Promise<InstallationScope | null> {
  const scope = scopeOf(options);
  if (
    options.project ||
    options.global ||
    options.yes ||
    !streams.input.isTTY ||
    !streams.output.isTTY
  )
    return scope;
  return selectAddScope({ project: context.roots.cwd, global: context.roots.home }, streams);
}

/** Проверяет явных агентов либо готовит меню; без списка и TTY бросает ошибку до чтения источника. */
export async function selectAgents(
  agents: readonly AgentId[],
  context: RuntimeContext,
  scope: InstallationScope,
  streams: PromptStreams,
): Promise<AgentId[] | null> {
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
