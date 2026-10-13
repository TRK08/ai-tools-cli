import { join, resolve } from 'node:path';
import type { RuntimeContext } from '../runtime.ts';
import type { AgentId, InstallationScope } from './types.ts';

export const AGENTS: readonly { readonly id: AgentId; readonly label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'pi', label: 'Pi' },
];

export function parseAgents(values: readonly string[]): AgentId[] {
  for (const value of values) {
    if (!AGENTS.some((agent) => agent.id === value)) {
      throw new Error(
        `Unknown agent: ${value}. Choose ${AGENTS.map((agent) => agent.id).join(', ')}.`,
      );
    }
  }
  return [...new Set(values)] as AgentId[];
}

export function agentSkillsDirectory(
  context: RuntimeContext,
  scope: InstallationScope,
  agent: AgentId,
): string {
  const { cwd, home } = context.roots;
  if (scope === 'project') {
    return join(
      cwd,
      agent === 'claude-code' ? '.claude' : agent === 'pi' ? '.pi' : '.agents',
      'skills',
    );
  }
  switch (agent) {
    case 'claude-code':
      return join(
        resolve(cwd, context.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')),
        'skills',
      );
    case 'opencode':
      return join(
        resolve(cwd, context.env.XDG_CONFIG_HOME?.trim() || join(home, '.config')),
        'opencode',
        'skills',
      );
    case 'codex':
      return join(home, '.agents', 'skills');
    case 'cursor':
      return join(home, '.cursor', 'skills');
    case 'pi':
      return join(home, '.pi', 'agent', 'skills');
  }
}
