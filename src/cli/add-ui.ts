import { confirm, isCancel, log, note, select } from '@clack/prompts';
import { emitKeypressEvents, type Key } from 'node:readline';
import type { RuntimeContext } from '../runtime.ts';
import { AGENTS } from '../installer/agents.ts';
import type { AddDecision, AddPreview } from '../installer/local.ts';
import type { InstallationScope } from '../installer/types.ts';
import { RegistryClient } from '../registry/client.ts';
import type { SkillDetail } from '../registry/catalog.ts';
import type { PromptStreams } from './agents-prompt.ts';
import { terminalText } from './discovery-ui.ts';
import { renderTable, wrapTerminalText } from './table.ts';
import { policyLabel } from './labels.ts';

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

function card(preview: AddPreview, details: SkillDetail | undefined, streams: PromptStreams) {
  const width = Math.max(16, (streams.output.columns ?? 80) - 8);
  const clean = (value: string) => value.split(/\r?\n/).map(terminalText).join('\n');
  const lines = [
    `Имя: ${details?.name ?? preview.name}`,
    ...(preview.source.kind === 'registry' ? [`Slug: ${preview.source.slug}`] : []),
    `Версия: ${preview.version ?? 'локальный источник'}`,
    `Источник: ${preview.source.kind === 'registry' ? preview.source.registryUrl : preview.source.path}`,
    `Область: ${preview.scope === 'project' ? 'локальная — текущий проект' : 'глобальная — для пользователя'}`,
    `Политика: ${policyLabel(preview.policy)}`,
    '',
    details?.shortDescription ?? preview.description ?? '',
    ...(details?.longDescription ? ['', details.longDescription] : []),
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
  renderTable(
    [
      { title: 'Агент', maximum: 20 },
      { title: 'Путь установки', maximum: 100 },
    ],
    preview.destinations.map(({ agent, path }) => [
      AGENTS.find((item) => item.id === agent)!.label,
      terminalText(path),
    ]),
    streams.output,
  );
}

/** Own cancellation only while preparing; Clack owns input during confirmation. */
export function createAddUi(context: RuntimeContext, streams: PromptStreams, yes = false) {
  const controller = new AbortController();
  let listening = false;
  const previousRaw = streams.input.isRaw ?? false;
  const cancelLoading = () => controller.abort();
  const onKey = (_value: string, key: Key) => {
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) cancelLoading();
  };
  const stopLoading = () => {
    if (!listening) return;
    listening = false;
    streams.input.off('keypress', onKey);
    streams.input.off('end', cancelLoading);
    streams.input.setRawMode?.(previousRaw);
    streams.input.pause();
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (streams.input.isTTY && streams.output.isTTY) {
      log.info('Подготовка карточки… Esc / Ctrl+C — отмена', { output: streams.output });
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
    if (yes) return 'approve';
    const accepted = await confirm({
      message: `Установить ${terminalText(preview.name)}?`,
      initialValue: false,
      active: 'Да, установить',
      inactive: 'Нет',
      input: streams.input,
      output: streams.output,
    });
    return isCancel(accepted) ? 'cancel' : accepted ? 'approve' : 'decline';
  };
  return { run, review, signal: controller.signal };
}
