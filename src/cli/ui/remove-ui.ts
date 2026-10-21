import { confirm } from '../terminal/select.ts';
import { cancel, intro, log, note, outro } from '@clack/prompts';
import type { InstallationChange } from '../../installer/types.ts';
import type { AgentId } from '../../agents/catalog.ts';
import type { InstallationScope } from '../../runtime.ts';
import type { InstallationRecord } from '../../state/types.ts';
import type { PromptStreams } from '../terminal/types.ts';
import { renderTable } from '../terminal/table.ts';
import { multiselect } from '../terminal/multiselect.ts';
import { failureLabel, plural, scopeLabel } from './labels.ts';

/**
 * Печатает заголовок удаления и создаёт callbacks выбора, общего подтверждения и результатов. Все диалоги
 * работают с переданными записями; файлы и lock здесь не изменяются.
 */
export function createRemoveUi(
  streams: PromptStreams,
  scope: InstallationScope,
  agents: readonly AgentId[],
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

  /**
   * Выбирает несколько записей без предвыбора и возвращает их в порядке исходного списка.
   *
   * @returns Выбранные записи либо null при отмене.
   */
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
      required: true,
      maxItems: 8,
      input: streams.input,
      output: streams.output,
    });
    if (selected === null) {
      cancel('Удаление отменено.', options);
      return null;
    }
    return records.filter((record) => selected.includes(record.name));
  };

  /**
   * Показывает весь выбранный список перед подтверждением или удалением с --yes.
   */
  const preview = (records: readonly InstallationRecord[]): void => {
    renderTable(columns, records.map(row), streams.output);
  };
  /** Подтверждает показанный список; TTY и --yes проверяет сценарий до вызова. */
  const review = async (records: readonly InstallationRecord[]): Promise<boolean> => {
    const accepted = await confirm({
      message: `Удалить ${records.length} ${plural(records.length, 'скилл', 'скилла', 'скиллов')} у перечисленных агентов?`,
      active: 'Да, удалить',
      inactive: 'Нет, оставить',
      input: streams.input,
      output: streams.output,
    });
    if (!accepted) {
      cancel(accepted === null ? 'Удаление отменено.' : 'Удаление отклонено.', options);
      return false;
    }
    return true;
  };

  /** Показывает результаты в порядке подтверждённых записей и диагностику partial/failed. */
  const finish = (
    records: readonly InstallationRecord[],
    results: readonly InstallationChange[],
  ) => {
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
    const count = (status: InstallationChange['status']) =>
      results.filter((result) => result.status === status).length;
    outro(
      `Удалено: ${count('success')} · Нет совпадений: ${count('unchanged')} · Ошибок: ${count('partial') + count('failed')}`,
      options,
    );
  };

  return {
    select,
    preview,
    review,
    finish,
    missing: (name: string) => log.info(`${name} не имеет подходящей установки.`, options),
    /** Показывает отсутствие подходящих установок и завершает вывод без диалога. */
    empty: () => {
      note('Нет подходящих установленных скиллов для удаления.', 'Нет скиллов', options);
      outro('Нечего удалять.', options);
    },
  };
}
