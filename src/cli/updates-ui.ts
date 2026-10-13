import { cancel, confirm, intro, isCancel, log, note, outro } from '@clack/prompts';
import type { UpdateBatch, UpdateDecision, UpdatePreview } from '../installer/local.ts';
import type { PromptStreams } from './agents-prompt.ts';
import type { InstallationScope } from '../installer/types.ts';
import { renderTable } from './table.ts';
import { failureLabel, scopeLabel } from './labels.ts';

export function createUpdatesUi(
  streams: PromptStreams,
  yes = false,
  scope: InstallationScope = 'project',
) {
  const options = { output: streams.output };
  const previews = new Map<string, UpdatePreview>();
  const columns = [
    { title: 'Скилл', maximum: 32 },
    { title: 'Текущая', maximum: 32 },
    { title: 'Доступная', maximum: 32 },
    { title: 'Результат', maximum: 24 },
    { title: 'Агенты', maximum: 52 },
  ];
  const row = (name: string, result: string) => {
    const preview = previews.get(name);
    return [
      name,
      preview ? (preview.currentVersion ?? 'локальная') : '—',
      preview
        ? preview.status === 'pinned'
          ? 'не проверялась'
          : (preview.latestVersion ?? 'локальная')
        : '—',
      result,
      preview?.agents.join(', ') ?? '—',
    ];
  };
  let started = false;
  const start = () => {
    if (!started) {
      intro(`Обновление скиллов · ${scopeLabel(scope)}`, options);
      started = true;
    }
  };

  const review = async (preview: UpdatePreview): Promise<UpdateDecision> => {
    start();
    previews.set(preview.name, preview);
    const local = preview.sourceKind !== 'registry';
    const status =
      preview.status === 'pinned'
        ? 'Версия закреплена (exact); обновление пропущено.'
        : preview.status === 'unchanged'
          ? local
            ? 'В источнике нет изменений.'
            : 'Обновлений нет.'
          : preview.reason === 'copy'
            ? 'Установленное содержимое требует замены.'
            : preview.reason === 'connections'
              ? 'Подключения агентов требуют восстановления.'
              : preview.reason === 'artifact'
                ? 'Архив изменился.'
                : local
                  ? 'В источнике доступно обновлённое содержимое.'
                  : 'Доступна новая версия.';
    if (preview.status !== 'available' || yes) return 'approve';
    renderTable(columns, [row(preview.name, 'Доступно обновление')], streams.output);
    log.info(status, options);
    if (!streams.input.isTTY || !streams.output.isTTY)
      throw new Error(
        'Для подтверждения обновления нужны stdin и stdout терминала (TTY); в скриптах используйте --yes.',
      );
    const accepted = await confirm({
      message:
        preview.reason === 'connections'
          ? `Восстановить подключения для ${preview.name}?`
          : preview.reason === 'copy'
            ? `Заменить установленное содержимое ${preview.name}?`
            : `Обновить ${preview.name}${local ? '' : ` (${preview.currentVersion} → ${preview.latestVersion})`}?`,
      initialValue: false,
      active: 'Да, обновить',
      inactive: 'Нет, пропустить',
      input: streams.input,
      output: streams.output,
    });
    return isCancel(accepted) ? 'cancel' : accepted ? 'approve' : 'decline';
  };

  const finish = (batch: UpdateBatch) => {
    start();
    if (!batch.results.length) {
      note('Нет подходящих скиллов для обновления.', 'Нет подходящих скиллов', options);
      outro('Нечего обновлять.', options);
      return;
    }
    const label = (result: UpdateBatch['results'][number]) => {
      if (result.status === 'skipped')
        return result.reason === 'cancelled' ? 'Отменено' : 'Пропущен';
      return {
        success: 'Обновлён',
        unchanged: 'Актуален',
        pinned: 'Закреплён (exact)',
        partial: 'Частично',
        failed: 'Ошибка',
      }[result.status];
    };
    renderTable(
      columns,
      batch.results.map((result) => row(result.name, label(result))),
      streams.output,
    );
    if (batch.results.every((result) => result.status === 'unchanged'))
      log.info(
        [...previews.values()].every((preview) => preview.sourceKind !== 'registry')
          ? 'В источнике нет изменений.'
          : 'Обновлений нет.',
        options,
      );
    if (batch.results.some((result) => result.status === 'pinned'))
      log.info(
        'Закреплённые версии (exact) пропускаются. Используйте add <skill>, чтобы перейти на актуальную версию (latest).',
        options,
      );
    for (const result of batch.results) {
      if (result.status === 'failed' || result.status === 'partial')
        log.error(
          `${failureLabel(result.status)} ${result.name}: ${result.errors.join('; ')}`,
          options,
        );
      else if (result.status === 'skipped') {
        if (result.reason === 'cancelled') {
          cancel(`Отменено перед обновлением ${result.name}.`, options);
          return;
        }
        log.info(`Пропущен ${result.name}; обновление отклонено.`, options);
      }
    }
    const count = (status: string) =>
      batch.results.filter((result) => result.status === status).length;
    outro(
      `Обновлено: ${count('success')} · Без изменений: ${count('unchanged')} · Закреплено: ${count('pinned')} · Пропущено: ${count('skipped')} · Ошибок: ${count('failed') + count('partial')}`,
      options,
    );
  };
  return { review, finish, report: (message: string) => log.info(message, options) };
}
