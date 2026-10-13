import { AGENTS, isAgentId, type AgentId } from '../agents/catalog.ts';
import type { InstallationScope, RuntimeContext } from '../runtime.ts';
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

/** Вычисляет текущий путь с учётом env; ранее сохранённые пути берутся из lock. */
export function agentSkillsDirectory(
  context: RuntimeContext,
  scope: InstallationScope,
  agent: AgentId,
): string {
  return AGENTS.find((entry) => entry.id === agent)![scope].directory(context);
}
