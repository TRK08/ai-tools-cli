import { AGENTS, isAgentId, type AgentId } from '../agents/catalog.ts';
import type { InstallationScope, RuntimeContext } from '../runtime.ts';
import { validateNativePath } from '../state/native-path.ts';
export { AGENTS } from '../agents/catalog.ts';

/** Проверяет агентов и удаляет повторы, сохраняя порядок первого появления. */
export function parseAgents(values: readonly string[]): AgentId[] {
  const result: AgentId[] = [];
  for (const value of values) {
    if (!isAgentId(value))
      throw new Error(
        `Неизвестный агент: ${value}. Выберите ${AGENTS.map((agent) => agent.id).join(', ')}.`,
      );
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

/** Вычисляет нативный путь с учётом env; неоднозначный Windows env-путь отклоняется до resolve. */
export function agentSkillsDirectory(
  context: RuntimeContext,
  scope: InstallationScope,
  agent: AgentId,
): string {
  const configured = context.env.CLAUDE_CONFIG_DIR?.trim();
  if (agent === 'claude-code' && scope === 'global' && configured) {
    validateNativePath(configured);
  }
  return AGENTS.find((entry) => entry.id === agent)![scope].directory(context);
}
