import { isCancel, multiselect } from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';
import { AGENTS, agentSkillsDirectory, parseAgents } from '../installer/agents.ts';
import type { AgentId, InstallationScope } from '../installer/types.ts';
import type { RuntimeContext } from '../runtime.ts';

export interface PromptStreams {
  readonly input: Readable & { readonly isTTY?: boolean };
  readonly output: Writable & { readonly isTTY?: boolean };
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
      'Agent selection requires TTY stdin and stdout; specify -a <agent> (for example -a codex).',
    );
  }
  const selected = await multiselect<AgentId>({
    message: `Select agents (${scope}); arrows to move, space to toggle, Enter to confirm`,
    options: AGENTS.map((agent) => ({
      value: agent.id,
      label: agent.label,
      hint: agentSkillsDirectory(context, scope, agent.id),
    })),
    initialValues: ['claude-code', 'opencode', 'codex'],
    required: true,
    input: streams.input,
    output: streams.output,
  });
  return isCancel(selected) ? null : selected;
}
