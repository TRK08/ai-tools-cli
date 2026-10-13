import { isCancel } from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';
import { AGENTS, agentSkillsDirectory, parseAgents } from '../installer/agents.ts';
import type { AgentId, InstallationScope } from '../installer/types.ts';
import type { RuntimeContext } from '../runtime.ts';
import { multiselect } from './multiselect.ts';
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

export async function selectAgents(
  explicit: readonly string[],
  context: RuntimeContext,
  scope: InstallationScope,
  streams: PromptStreams,
): Promise<AgentId[] | null> {
  const agents = parseAgents(explicit);
  if (agents.length) return agents;
  if (!streams.input.isTTY || !streams.output.isTTY) {
    throw new Error(
      'Для выбора агентов нужны stdin и stdout терминала (TTY); укажите -a <agent> (например, -a codex).',
    );
  }
  const selected = await multiselect<AgentId>({
    message: `Выберите агентов (${scopeLabel(scope)}); стрелки — навигация, пробел — выбор, Enter — подтверждение`,
    options: AGENTS.map((agent) => ({
      value: agent.id,
      label: agent.label,
      hint: agentSkillsDirectory(context, scope, agent.id),
    })),
    initialValues: ['claude-code', 'opencode', 'codex'],
    input: streams.input,
    output: streams.output,
  });
  return isCancel(selected) || selected === undefined ? null : selected;
}
