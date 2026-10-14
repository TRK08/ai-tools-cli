import { confirm, isCancel, log, note, select } from '@clack/prompts';
import { emitKeypressEvents, type Key } from 'node:readline';
import type { RuntimeContext } from '../runtime.ts';
import { AGENTS } from '../installer/agents.ts';
import type { AddDecision, AddPreview } from '../installer/types.ts';
import type { InstallationScope } from '../installer/types.ts';
import { RegistryClient } from '../registry/client.ts';
import type { SkillDetail } from '../registry/catalog.ts';
import type { PromptStreams } from './agents-prompt.ts';
import { terminalText } from './discovery-ui.ts';
import { renderTable, wrapTerminalText } from './table.ts';
import { createLoading } from './loading.ts';

/**
 * Выбирает область add/find; -g и запуск без TTY обходят меню.
 *
 * @returns project/global либо null при отмене; без TTY по умолчанию project.
 */
export async function selectScope(
  global: boolean | undefined,
  context: RuntimeContext,
  streams: PromptStreams,
): Promise<InstallationScope | null> {
  if (global) return 'global';
  if (!streams.input.isTTY || !streams.output.isTTY) return 'project';
  const selected = await select<InstallationScope>({
    message: 'Область установки; стрелки — выбор, Enter — подтверждение',
    showInstructions: false,
    options: [
      { value: 'project', label: 'Локально — текущий проект', hint: context.roots.cwd },
      { value: 'global', label: 'Глобально — для пользователя', hint: context.roots.home },
    ],
    initialValue: 'project',
    input: streams.input,
    output: streams.output,
  });
  return isCancel(selected) ? null : selected;
}

/**
 * Показывает выбранную версию, источник, краткое описание и агентов для каждого пути.
 * Очищает управляющие символы данных и переносит строки по ширине терминала.
 */
function card(preview: AddPreview, details: SkillDetail | undefined, streams: PromptStreams) {
  const width = Math.max(16, (streams.output.columns ?? 80) - 8);
  const clean = (value: string) => value.split(/\r?\n/).map(terminalText).join('\n');
  const lines = [
    `Имя: ${details?.name ?? preview.name}`,
    ...(preview.source.kind === 'registry' ? [`Slug: ${preview.source.slug}`] : []),
    `Версия: ${preview.version ?? 'локальный источник'}`,
    `Источник: ${preview.source.kind === 'registry' ? preview.source.registryUrl : preview.source.path}`,
    `Область: ${preview.scope === 'project' ? 'локальная — текущий проект' : 'глобальная — для пользователя'}`,
    '',
    details?.shortDescription ?? preview.description ?? '',
    ...(details?.tags.length ? ['', `Теги: ${details.tags.join(', ')}`] : []),
    ...(details ? [`Установок: ${details.installCount}`] : []),
    '',
    `Общий каталог: ${preview.sharedDirectory}`,
  ];
  note(
    lines.flatMap((line) => wrapTerminalText(clean(line), width)).join('\n'),
    'Установка скилла',
    { output: streams.output },
  );
  const destinations = new Map<string, string[]>();
  for (const { agent, path } of preview.destinations) {
    const labels = destinations.get(path) ?? [];
    labels.push(AGENTS.find((item) => item.id === agent)!.label);
    destinations.set(path, labels);
  }
  renderTable(
    [
      { title: 'Агенты', maximum: 52 },
      { title: 'Путь установки', maximum: 100 },
    ],
    [...destinations].map(([path, labels]) => [labels.join(', '), terminalText(path)]),
    streams.output,
  );
}

/**
 * Создаёт callbacks карточки и подтверждения add/find вместе с сигналом отмены подготовки.
 *
 * @remarks run владеет клавиатурой до диалога, затем обработку ввода принимает Clack. Индикатор
 * очищается перед карточкой, вопросом, сообщением Installer и при завершении run.
 */
export function createAddUi(context: RuntimeContext, streams: PromptStreams, yes = false) {
  const controller = new AbortController();
  const loading = createLoading(streams);
  let listening = false;
  const previousRaw = streams.input.isRaw ?? false;
  const cancelLoading = () => controller.abort();
  const onKey = (_value: string, key: Key) => {
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) cancelLoading();
  };
  /** Очищает индикатор, снимает обработчики подготовки и восстанавливает прежний raw mode терминала. */
  const stopLoading = () => {
    loading.stop();
    if (!listening) return;
    listening = false;
    streams.input.off('keypress', onKey);
    streams.input.off('end', cancelLoading);
    streams.input.setRawMode?.(previousRaw);
    streams.input.pause();
  };
  /** Запускает подготовку с обработкой Esc/Ctrl+C; в finally освобождает терминальные обработчики. */
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (streams.input.isTTY && streams.output.isTTY) {
      loading.start('Подготовка скилла… Esc / Ctrl+C — отмена');
      emitKeypressEvents(streams.input);
      listening = true;
      streams.input.on('keypress', onKey);
      streams.input.on('end', cancelLoading);
      streams.input.setRawMode?.(true);
      streams.input.resume();
    }
    try {
      return await operation();
    } finally {
      stopLoading();
    }
  };
  /**
   * Получает registry-карточку именно выбранной версии, показывает её и запрашивает согласие.
   *
   * @returns approve/decline/cancel; --yes пропускает только финальный вопрос.
   */
  const review = async (preview: AddPreview): Promise<AddDecision> => {
    let details: SkillDetail | undefined;
    try {
      if (preview.source.kind === 'registry')
        details = await new RegistryClient(preview.source.registryUrl, context.http).getSkill(
          preview.source.slug,
          preview.version!,
          controller.signal,
        );
    } catch (cause) {
      if (controller.signal.aborted) return 'cancel';
      throw cause;
    }
    stopLoading();
    if (controller.signal.aborted) return 'cancel';
    card(preview, details, streams);
    if (yes) {
      loading.start('Установка скилла…');
      return 'approve';
    }
    const accepted = await confirm({
      message: `Установить ${terminalText(preview.name)}?`,
      initialValue: false,
      active: 'Да, установить',
      inactive: 'Нет',
      input: streams.input,
      output: streams.output,
    });
    const decision = isCancel(accepted) ? 'cancel' : accepted ? 'approve' : 'decline';
    if (decision === 'approve') loading.start('Установка скилла…');
    return decision;
  };
  /** Выводит сообщение установки между кадрами и продолжает индикатор следующего ожидания. */
  const report = (message: string) => {
    loading.stop();
    log.info(message, { output: streams.output });
    loading.start('Установка скилла…');
  };
  return { run, review, report, signal: controller.signal };
}
