/** Каталог и разрешение подключений; потребители не зависят от расположения реализаций. */
export { AGENTS, agentConnectionKind, isAgentId, isDirectAgent } from './catalog';
export type { AgentId, ConnectionKind } from './catalog';
export { agentSkillsDirectory, parseAgents } from './resolve';
