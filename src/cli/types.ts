import type { RuntimeContext } from '../runtime.ts';
import type { PromptStreams } from './terminal/types.ts';

/** Окружение одной команды; реальные зависимости создаются только в точке запуска. */
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
}
export interface MutationOptions extends ScopeOptions {
  readonly yes?: boolean;
}
export interface UpdateOptions extends MutationOptions {
  readonly force?: boolean;
  readonly withoutStat?: boolean;
}
export interface AddOptions extends UpdateOptions {
  readonly registry?: string;
}
