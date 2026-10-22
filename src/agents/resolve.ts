import { AGENTS, isAgentId, type AgentId, type AgentConnectionDefinition } from './catalog';
import type { InstallationScope, RuntimeContext } from '@/runtime';
import { nativePath, validateNativePath } from '@/paths';

/** Проверяет ID по каталогу и удаляет повторы по первому появлению; неизвестный ID вызывает ошибку. */
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

/** Вычисляет каталог без I/O; пустой env оставляет default, небезопасный raw env-путь отклоняется до resolve. */
export function agentSkillsDirectory(
  context: RuntimeContext,
  scope: InstallationScope,
  agent: AgentId,
): string {
  const definition: AgentConnectionDefinition = AGENTS.find((entry) => entry.id === agent)![scope];
  const environment = definition.environment;
  const configured = environment && context.env[environment.name]?.trim();
  if (!configured) return definition.directory(context.roots);
  validateNativePath(configured);
  return nativePath.join(nativePath.resolve(context.roots.cwd, configured), ...environment.suffix);
}
