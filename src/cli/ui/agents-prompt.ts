import type { AgentId } from '@/agents';
import { type PromptStreams, multiselect } from '@/cli/terminal';
import type { AgentsView } from './types';

/** Показывает готовые варианты агентов; отмена возвращает null после освобождения терминала. */
export async function selectAgentChoices(
  view: AgentsView,
  streams: PromptStreams,
): Promise<AgentId[] | null> {
  const selected = await multiselect<AgentId>({
    message: `Выберите агентов (${view.scope})`,
    search: true,
    context: [`Общая папка: ${view.sharedDirectory}`],
    lockedLabel: 'Всегда включены',
    optionsLabel: 'Дополнительные агенты',
    locked: view.locked,
    options: view.options,
    input: streams.input,
    output: streams.output,
  });
  return selected;
}
