import type { Decision, PackagePreview, PackageResult } from '@/installer';
import {
  confirm,
  multiselect,
  terminalText,
  type Choice,
  type PromptStreams,
} from '@/cli/terminal';

import { scopeLabel } from './labels';

const actions = {
  add: 'установка',
  update: 'обновление',
  remove: 'удаление',
  disconnect: 'отключение',
};

/** Показывает выбранные версии, затронутые подключения и пути с локальными правками. */
export function showPackagePreview(preview: PackagePreview, output: PromptStreams['output']): void {
  const transition =
    preview.previousVersion && preview.previousVersion !== preview.version
      ? `${preview.previousVersion} → ${preview.version}`
      : preview.version;
  const lines = [`${preview.slug}  ${transition}  (${scopeLabel(preview.scope)})`];
  for (const skill of preview.skills) {
    lines.push(`  ${skill.name} — ${actions[skill.action]} (${skill.agents.join(', ')})`);
    for (const path of skill.modifiedPaths)
      lines.push(`    Ручные правки будут потеряны: ${terminalText(path)}`);
  }
  output.write(lines.join('\n') + '\n');
}

/** Выбирает непустой список с отметкой всех вариантов по умолчанию. */
export function chooseAll<Value>(
  message: string,
  options: readonly Choice<Value>[],
  streams: PromptStreams,
): Promise<Value[] | null> {
  return multiselect({
    ...streams,
    message,
    options,
    initialValues: options.map((item) => item.value),
    required: true,
  });
}

/** С --yes не открывает диалог. Отмена и явный отказ возвращаются раздельно. */
export async function confirmChanges(
  message: string,
  streams: PromptStreams,
  yes?: boolean,
): Promise<Decision> {
  if (yes) return 'approve';
  const result = await confirm({
    ...streams,
    message,
    active: 'Да',
    inactive: 'Нет',
    summary: false,
  });
  return result === null ? 'cancel' : result ? 'approve' : 'decline';
}

/** Выводит итог одной пакетной операции после освобождения файловых ресурсов. */
export function showPackageResult(
  result: PackageResult | null,
  success: string,
  output: PromptStreams['output'],
): void {
  const message =
    result === 'success'
      ? success
      : result === 'unchanged'
        ? 'Без изменений.'
        : result === 'declined'
          ? 'Изменения отклонены.'
          : 'Отменено.';
  output.write(message + '\n');
}
