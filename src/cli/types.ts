import type { RuntimeContext } from '@/runtime';
import type { PromptStreams } from '@/cli/terminal';

/** Окружение одной команды. Реальные зависимости создаются в точке запуска. */
export interface CliContext {
  readonly runtime: RuntimeContext;
  readonly version: string;
  readonly stdin: PromptStreams['input'];
  readonly stdout: PromptStreams['output'];
  readonly stderr: PromptStreams['output'];
}

export interface ScopeOptions {
  readonly agent: string[];
  readonly global?: boolean;
  readonly project?: boolean;
}

export interface MutationOptions extends ScopeOptions {
  readonly yes?: boolean;
  readonly skill: string[];
  readonly withoutStat?: boolean;
}

export interface FindOptions extends ScopeOptions {
  readonly registry?: string;
  readonly yes?: boolean;
  readonly withoutStat?: boolean;
}

export interface AddOptions extends MutationOptions {
  readonly registry?: string;
}
