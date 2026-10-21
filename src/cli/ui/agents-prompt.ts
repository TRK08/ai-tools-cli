import type { AgentId } from '../../installer/types.ts';
import type { PromptStreams } from '../terminal/types.ts';
import type { AgentsView } from './types.ts';
import { multiselect } from '../terminal/multiselect.ts';

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
