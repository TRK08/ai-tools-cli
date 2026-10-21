import type { CliContext, ScopeOptions } from './types.ts';
import type { PromptStreams } from './terminal/types.ts';
import type { InstallationScope } from '../runtime.ts';

/** Передаёт терминальным компонентам только ввод и вывод текущей команды. */
export function promptStreams(context: CliContext): PromptStreams {
  return { input: context.stdin, output: context.stdout };
}

/** Выбирает область команд без интерактивного меню. */
export function scopeOf(options: Pick<ScopeOptions, 'global'>): InstallationScope {
  return options.global ? 'global' : 'project';
}
