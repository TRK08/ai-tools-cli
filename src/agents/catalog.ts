import { nativePath } from '../state/native-path.ts';
import type { InstallationScope, RuntimeContext } from '../runtime.ts';

export type ConnectionKind = 'direct' | 'copy' | 'link';

/** Единый каталог: порядок массива задаёт меню, helpOrder сохраняет порядок справки. */
export const AGENTS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    helpOrder: 0,
    project: {
      kind: 'link',
      directory: (context: RuntimeContext) =>
        nativePath.join(context.roots.cwd, '.claude', 'skills'),
    },
    global: {
      kind: 'link',
      directory: (context: RuntimeContext) =>
        nativePath.join(
          nativePath.resolve(
            context.roots.cwd,
            context.env.CLAUDE_CONFIG_DIR?.trim() || nativePath.join(context.roots.home, '.claude'),
          ),
          'skills',
        ),
    },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    helpOrder: 2,
    project: {
      kind: 'direct',
      directory: (context: RuntimeContext) =>
        nativePath.join(context.roots.cwd, '.agents', 'skills'),
    },
    global: {
      kind: 'direct',
      directory: (context: RuntimeContext) =>
        nativePath.join(context.roots.home, '.agents', 'skills'),
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    helpOrder: 1,
    project: {
      kind: 'direct',
      directory: (context: RuntimeContext) =>
        nativePath.join(context.roots.cwd, '.agents', 'skills'),
    },
    global: {
      kind: 'direct',
      directory: (context: RuntimeContext) =>
        nativePath.join(context.roots.home, '.agents', 'skills'),
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    helpOrder: 4,
    project: {
      kind: 'direct',
      directory: (context: RuntimeContext) =>
        nativePath.join(context.roots.cwd, '.agents', 'skills'),
    },
    global: {
      kind: 'direct',
      directory: (context: RuntimeContext) =>
        nativePath.join(context.roots.home, '.agents', 'skills'),
    },
  },
  {
    id: 'pi',
    label: 'Pi',
    helpOrder: 3,
    project: {
      kind: 'direct',
      directory: (context: RuntimeContext) =>
        nativePath.join(context.roots.cwd, '.agents', 'skills'),
    },
    global: {
      kind: 'direct',
      directory: (context: RuntimeContext) =>
        nativePath.join(context.roots.home, '.agents', 'skills'),
    },
  },
] as const;

export type AgentId = (typeof AGENTS)[number]['id'];

/** Проверяет идентификатор по каталогу без приведения произвольной строки к AgentId. */
export function isAgentId(value: unknown): value is AgentId {
  return AGENTS.some((agent) => agent.id === value);
}

/** Указывает, читает ли агент общую копию напрямую в выбранной области. */
export function isDirectAgent(agent: AgentId, scope: InstallationScope): boolean {
  return agentConnectionKind(agent, scope) === 'direct';
}

/** Возвращает вид подключения из единого каталога для агента и области; файловых операций нет. */
export function agentConnectionKind(agent: AgentId, scope: InstallationScope): ConnectionKind {
  return AGENTS.find((entry) => entry.id === agent)![scope].kind;
}
