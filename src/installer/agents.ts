import {
  AGENTS,
  isAgentId,
  type AgentId,
  type AgentConnectionDefinition,
} from '../agents/catalog.ts';
import type { InstallationScope, RuntimeContext } from '../runtime.ts';
import { nativePath, validateNativePath } from '../state/native-path.ts';
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

/** Разрешает каталог из настроек области; raw env-путь проверяется до resolve, пустой env оставляет default. */
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
