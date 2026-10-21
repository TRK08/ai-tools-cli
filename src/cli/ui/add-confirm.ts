import type { AddDecision } from '../../installer/types.ts';
import type { InstallationScope } from '../../runtime.ts';
import type { PromptStreams } from '../terminal/types.ts';
import { confirm, select } from '../terminal/select.ts';
import { terminalText } from '../terminal/text.ts';

/** Подтверждает add/find с предвыбранным «Нет»; отмена/EOF возвращают cancel после очистки TTY. */
export function confirmAdd(
  name: string,
  streams: PromptStreams,
  signal: AbortSignal,
): Promise<AddDecision> {
  return confirm({
    ...streams,
    message: `Установить ${terminalText(name)}?`,
    active: 'Да, установить',
    inactive: 'Нет',
    signal,
    summary: false,
    submitOnKey: false,
  }).then((value) => (value === null ? 'cancel' : value ? 'approve' : 'decline'));
}

/** Выбирает project/global; закрытие потоков возвращает null после восстановления терминала. */
export function selectAddScope(
  directories: Readonly<Record<InstallationScope, string>>,
  streams: PromptStreams,
): Promise<InstallationScope | null> {
  return select<InstallationScope>({
    ...streams,
    message: 'Область установки; стрелки — выбор, Enter — подтверждение',
    options: [
      {
        value: 'project',
        label: `Локально — текущий проект (${terminalText(directories.project)})`,
      },
      {
        value: 'global',
        label: `Глобально — для пользователя (${terminalText(directories.global)})`,
      },
    ],
    initialValue: 'project',
  });
}
