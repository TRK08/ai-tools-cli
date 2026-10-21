import { nativePath } from '../state/native-path.ts';
import type { FileSystemRoots, InstallationScope } from '../runtime.ts';

export type ConnectionKind = 'direct' | 'copy' | 'link';

/** Каталог по умолчанию зависит только от корней; env задаёт альтернативную базу и суффикс в своей области. */
export interface AgentConnectionDefinition {
  readonly kind: ConnectionKind;
  readonly directory: (roots: FileSystemRoots) => string;
  readonly environment?: {
    readonly name: string;
    readonly suffix: readonly string[];
  };
}

/** Настройки агента для меню, справки и подключений; идентификаторы продукта выводятся из AGENTS. */
export interface AgentDefinition {
  readonly id: string;
  readonly label: string;
  readonly helpOrder: number;
  readonly project: AgentConnectionDefinition;
  readonly global: AgentConnectionDefinition;
}

const SHARED_CONNECTIONS = {
  project: {
    kind: 'direct',
    directory: (roots: FileSystemRoots) => nativePath.join(roots.cwd, '.agents', 'skills'),
  },
  global: {
    kind: 'direct',
    directory: (roots: FileSystemRoots) => nativePath.join(roots.home, '.agents', 'skills'),
  },
} as const;

/** Единый каталог: порядок массива задаёт меню, helpOrder сохраняет порядок справки. */
export const AGENTS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    helpOrder: 0,
    project: {
      kind: 'copy',
      directory: (roots: FileSystemRoots) => nativePath.join(roots.cwd, '.claude', 'skills'),
    },
    global: {
      kind: 'link',
      directory: (roots: FileSystemRoots) => nativePath.join(roots.home, '.claude', 'skills'),
      environment: { name: 'CLAUDE_CONFIG_DIR', suffix: ['skills'] },
    },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    helpOrder: 2,
    ...SHARED_CONNECTIONS,
  },
  {
    id: 'codex',
    label: 'Codex',
    helpOrder: 1,
    ...SHARED_CONNECTIONS,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    helpOrder: 4,
    ...SHARED_CONNECTIONS,
  },
  {
    id: 'pi',
    label: 'Pi',
    helpOrder: 3,
    ...SHARED_CONNECTIONS,
  },
] as const satisfies readonly AgentDefinition[];

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
