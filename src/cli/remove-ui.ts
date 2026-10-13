import { cancel, confirm, intro, isCancel, log, note, outro } from '@clack/prompts';
import type { LocalChange } from '../installer/local.ts';
import type { AgentId, InstallationScope } from '../installer/types.ts';
import type { InstallationRecord } from '../state/types.ts';
import type { PromptStreams } from './agents-prompt.ts';
import { renderTable } from './table.ts';
import { multiselect } from './multiselect.ts';
import { failureLabel, plural, scopeLabel } from './labels.ts';

export function createRemoveUi(
  streams: PromptStreams,
  scope: InstallationScope,
  agents: readonly AgentId[],
  yes = false,
) {
  const options = { output: streams.output };
  const columns = [
    { title: 'Скилл', maximum: 32 },
    { title: 'Версия', maximum: 32 },
    { title: 'Агенты', maximum: 52 },
  ];
  const affected = (record: InstallationRecord) =>
    record.agents.filter((agent) => !agents.length || agents.includes(agent));
  const row = (record: InstallationRecord) => [
    record.name,
    record.version ?? 'локальная',
    affected(record).join(', '),
  ];
  intro(
    `Удаление скиллов · ${scopeLabel(scope)}${agents.length ? ` · фильтр: ${agents.join(', ')}` : ''}`,
    options,
  );

  const select = async (records: readonly InstallationRecord[]) => {
    const selected = await multiselect<string>({
      message:
        'Выберите скиллы для удаления; стрелки — навигация, пробел — выбор, Enter — подтверждение',
      options: records.map((record) => ({
        value: record.name,
        label: record.name,
        hint: `${record.version ?? 'локальная'} · ${affected(record).join(', ')}`,
      })),
      initialValues: [],
      maxItems: 8,
      input: streams.input,
      output: streams.output,
    });
    if (isCancel(selected) || selected === undefined) {
      cancel('Удаление отменено.', options);
      return null;
    }
    return records.filter((record) => selected.includes(record.name));
  };

  const review = async (records: readonly InstallationRecord[]) => {
    renderTable(columns, records.map(row), streams.output);
    if (yes) return true;
    if (!streams.input.isTTY || !streams.output.isTTY)
      throw new Error(
        'Для подтверждения удаления нужны stdin и stdout терминала (TTY); в скриптах используйте remove <name> --yes.',
      );
    const accepted = await confirm({
      message: `Удалить ${records.length} ${plural(records.length, 'скилл', 'скилла', 'скиллов')} у перечисленных агентов?`,
      initialValue: false,
      active: 'Да, удалить',
      inactive: 'Нет, оставить',
      input: streams.input,
      output: streams.output,
    });
    if (isCancel(accepted) || !accepted) {
      cancel(isCancel(accepted) ? 'Удаление отменено.' : 'Удаление отклонено.', options);
      return false;
    }
    return true;
  };

  const finish = (records: readonly InstallationRecord[], results: readonly LocalChange[]) => {
    renderTable(
      [...columns.slice(0, 2), { title: 'Результат', maximum: 16 }, columns[2]!],
      results.map((result, index) => {
        const values = row(records[index]!);
        const label = {
          success: 'Удалён',
          unchanged: 'Нет совпадений',
          partial: 'Частично',
          failed: 'Ошибка',
        }[result.status];
        return [...values.slice(0, 2), label, values[2]!];
      }),
      streams.output,
    );
    for (const result of results)
      if (result.status === 'partial' || result.status === 'failed')
        log.error(
          `${result.name}: ${failureLabel(result.status)}: ${result.errors.join('; ')}`,
          options,
        );
    const count = (status: LocalChange['status']) =>
      results.filter((result) => result.status === status).length;
    outro(
      `Удалено: ${count('success')} · Нет совпадений: ${count('unchanged')} · Ошибок: ${count('partial') + count('failed')}`,
      options,
    );
  };

  return {
    select,
    review,
    finish,
    missing: (name: string) => log.info(`${name} не имеет подходящей установки.`, options),
    empty: () => {
      note('Нет подходящих установленных скиллов для удаления.', 'Нет скиллов', options);
      outro('Нечего удалять.', options);
    },
  };
}
