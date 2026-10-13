import { intro, note, outro } from '@clack/prompts';
import type { AgentId, InstallationScope } from '../installer/types.ts';
import type { InstallationRecord } from '../state/types.ts';
import type { PromptStreams } from './agents-prompt.ts';
import { renderTable } from './table.ts';
import { policyLabel, scopeLabel } from './labels.ts';

export function renderSkillList(
  records: readonly InstallationRecord[],
  scope: InstallationScope,
  agents: readonly AgentId[],
  streams: PromptStreams,
): void {
  const options = { output: streams.output };
  intro(
    `Установленные скиллы · ${scopeLabel(scope)}${agents.length ? ` · фильтр: ${agents.join(', ')}` : ''}`,
    options,
  );
  if (!records.length) {
    note(
      agents.length
        ? `Нет скиллов для выбранных агентов ${scope === 'project' ? 'в текущем проекте' : 'в глобальной области'}.`
        : `Нет установленных скиллов ${scope === 'project' ? 'в текущем проекте' : 'в глобальной области'}.`,
      'Нет скиллов',
      options,
    );
    outro('Скиллов: 0.', options);
    return;
  }
  renderTable(
    [
      { title: 'Скилл', maximum: 32 },
      { title: 'Версия', maximum: 32 },
      { title: 'Политика', maximum: 24 },
      { title: 'Агенты', maximum: 52 },
    ],
    records.map((record) => [
      record.name,
      record.version ?? 'локальная',
      policyLabel(record.policy),
      record.agents.join(', '),
    ]),
    streams.output,
  );
  const connections = records.reduce((total, record) => total + record.connections.length, 0);
  outro(`Скиллов: ${records.length} · Подключений: ${connections}.`, options);
}
