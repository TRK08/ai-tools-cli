export type AgentId = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'cursor';

export type InstallationScope = 'project' | 'global';

export type OperationResult =
  | { readonly status: 'success' | 'unchanged' | 'cancelled'; readonly exitCode: 0 }
  | {
      readonly status: 'partial' | 'failed';
      readonly exitCode: 1;
      readonly errors: readonly string[];
    };
