import type { CliContext, ScopeOptions } from './types';
import type { PromptStreams } from '@/cli/terminal';
import type { InstallationScope } from '@/runtime';

/** Передаёт терминальным компонентам только ввод и вывод текущей команды. */
export function promptStreams(context: CliContext): PromptStreams {
  return {
    input: context.stdin,
    output: context.stdout,
    ...(context.runtime.signal && { signal: context.runtime.signal }),
  };
}

/** Проверяет взаимоисключающие флаги области. Без флагов возвращает проект. */
export function scopeOf(options: ScopeOptions): InstallationScope {
  if (options.project && options.global)
    throw new Error('Параметры --project и --global взаимоисключающие.');
  return options.global ? 'global' : 'project';
}
