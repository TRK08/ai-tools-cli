import { S_BAR, S_STEP_ACTIVE, S_RADIO_ACTIVE, S_RADIO_INACTIVE } from '@clack/prompts';
import type { Key } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'fast-string-width';
import type { AddDecision } from '../installer/types.ts';
import type { PromptStreams } from './agents-prompt.ts';
import { terminalSession } from './terminal-session.ts';
import { terminalText } from './discovery-ui.ts';
import { wrapTerminalText } from './table.ts';
import { formatChoice } from './selection-style.ts';
import type { InstallationScope, RuntimeContext } from '../runtime.ts';

/**
 * Подтверждает add/find с предвыбранным «Нет». EOF/close отменяют, ошибки setup/render/потоков
 * отклоняют Promise после восстановления терминала; сигнал отмены снимается при любом завершении.
 */
export function confirmAdd(
  name: string,
  streams: PromptStreams,
  signal: AbortSignal,
): Promise<AddDecision> {
  return selectAddChoice<AddDecision>(
    `Установить ${terminalText(name)}?`,
    [
      { value: 'approve', label: 'Да, установить' },
      { value: 'decline', label: 'Нет' },
    ],
    1,
    streams,
    signal,
    true,
  ).then((decision) => decision ?? 'cancel');
}

/** Выбирает project/global; закрытие потоков возвращает null после восстановления терминала. */
export function selectAddScope(
  context: RuntimeContext,
  streams: PromptStreams,
): Promise<InstallationScope | null> {
  return selectAddChoice<InstallationScope>(
    'Область установки; стрелки — выбор, Enter — подтверждение',
    [
      { value: 'project', label: `Локально — текущий проект (${terminalText(context.roots.cwd)})` },
      {
        value: 'global',
        label: `Глобально — для пользователя (${terminalText(context.roots.home)})`,
      },
    ],
    0,
    streams,
  );
}

/** Ведёт два варианта add с общим владением терминалом; ошибки очистки не скрывают первичную. */
function selectAddChoice<Value>(
  message: string,
  choices: readonly { value: Value; label: string }[],
  initial: number,
  streams: PromptStreams,
  signal?: AbortSignal,
  confirmation = false,
): Promise<Value | null> {
  const { input, output } = streams;
  if (
    signal?.aborted ||
    input.destroyed ||
    input.readableEnded ||
    output.destroyed ||
    output.writableEnded
  )
    return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let closed = false;
    let selected = initial;
    let lines = 0;
    let previousFrame: string[] = [];
    const session = terminalSession(streams, {
      key: onKey,
      end: onEnd,
      error: (cause) => finish(null, cause),
      resize: () => {
        const width = Math.max(1, output.columns ?? 80);
        lines = previousFrame.reduce(
          (sum, line) => sum + Math.max(1, Math.ceil(stringWidth(line) / width)),
          0,
        );
        render();
      },
    });

    /** Завершает диалог один раз и сохраняет первичную ошибку при отказе очистки. */
    function finish(decision: Value | null, error?: unknown) {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', onEnd);
      try {
        if (!output.destroyed && !output.writableEnded) output.write('\u001b[?25h');
      } catch (cause) {
        error ??= cause;
      }
      const cleanup = session.close();
      error ??= cleanup;
      if (error !== undefined) reject(error);
      else resolve(decision);
    }

    /** Переносит заголовок и варианты по ширине; cursor/raw управляет только этот диалог. */
    function render() {
      if (closed) return;
      try {
        const width = Math.max(1, (output.columns ?? 80) - 1);
        const frame = [
          ...wrapTerminalText(`${S_STEP_ACTIVE} ${message}`, width),
          ...choices.flatMap((choice, index) => {
            const active = index === selected;
            const marker = active ? S_RADIO_ACTIVE : S_RADIO_INACTIVE;
            return wrapTerminalText(`${S_BAR} ${marker} ${choice.label}`, width).map((line) =>
              formatChoice(line, marker, active, false, output),
            );
          }),
        ];
        if (lines) output.write(`\u001b[${lines}A\r\u001b[J`);
        lines = frame.length;
        previousFrame = frame.map(stripVTControlCharacters);
        output.write(frame.join('\n') + '\n');
      } catch (cause) {
        finish(null, cause);
      }
    }
    function onEnd() {
      finish(null);
    }
    function onKey(value: string | undefined, key: Key) {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(null);
      if (key.name === 'return') return finish(choices[selected]!.value);
      if (['up', 'down', 'left', 'right', 'tab', 'space'].includes(key.name ?? ''))
        selected = selected === 0 ? 1 : 0;
      else if (confirmation && value?.toLowerCase() === 'y') selected = 0;
      else if (confirmation && value?.toLowerCase() === 'n') selected = 1;
      render();
    }
    try {
      session.start();
      signal?.addEventListener('abort', onEnd, { once: true });
      output.write('\u001b[?25l');
      render();
    } catch (cause) {
      finish(null, cause);
    }
  });
}
