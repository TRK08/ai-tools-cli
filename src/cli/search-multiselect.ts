import {
  S_BAR,
  S_BAR_END,
  S_CHECKBOX_SELECTED,
  S_CHECKBOX_INACTIVE,
  S_STEP_ACTIVE,
} from '@clack/prompts';
import { emitKeypressEvents, type Key } from 'node:readline';
import { styleText } from 'node:util';
import stringWidth from 'fast-string-width';
import type { PromptStreams } from './agents-prompt.ts';
import { terminalText } from './discovery-ui.ts';
import { truncateTerminalText } from './table.ts';
import { formatChoice } from './selection-style.ts';

interface SearchChoice<Value> {
  readonly value: Value;
  readonly label: string;
  readonly hint?: string;
}

interface SearchMultiselectOptions<Value> extends PromptStreams {
  readonly message: string;
  readonly sharedDirectory: string;
  readonly locked: readonly SearchChoice<Value>[];
  readonly options: readonly SearchChoice<Value>[];
}

/**
 * Выбирает дополнительные пункты локальным поиском, всегда включая закреплённые.
 *
 * @returns Закреплённые и отмеченные значения в порядке входных списков либо null при отмене/EOF.
 * @remarks Владеет обработчиками ввода/resize до завершения; восстанавливает raw mode и поток.
 * Ошибки потоков отклоняют Promise после очистки. Enter в слишком маленьком окне недоступен.
 */
export function searchMultiselect<Value>(
  options: SearchMultiselectOptions<Value>,
): Promise<Value[] | null> {
  const { input, output, locked } = options;
  if (input.destroyed || input.readableEnded) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const previousRaw = input.isRaw ?? false;
    const wasFlowing = input.readableFlowing === true;
    const selected = new Set<Value>();
    let closed = false;
    let query = '';
    let cursor = 0;
    let previousLines: string[] = [];
    let canSubmit = false;

    const filtered = () =>
      options.options.filter(
        (item) =>
          item.label.toLowerCase().includes(query.toLowerCase()) ||
          String(item.value).toLowerCase().includes(query.toLowerCase()),
      );
    const chosen = () => [...locked, ...options.options.filter((item) => selected.has(item.value))];

    /** Стирает только предыдущий кадр меню, включая строки, перенесённые после resize. */
    function clear() {
      if (previousLines.length) output.write(`\u001b[${previousLines.length}A\r\u001b[J`);
      previousLines = [];
    }

    /** Завершает меню один раз и освобождает принадлежащие ему ресурсы при любом исходе. */
    function finish(value: Value[] | null, error?: unknown) {
      if (closed) return;
      closed = true;
      input.off('keypress', onKey);
      input.off('end', onEnd);
      input.off('close', onEnd);
      input.off('error', onError);
      output.off('error', onError);
      output.off('resize', onResize);
      try {
        input.setRawMode?.(previousRaw);
        if (wasFlowing) input.resume();
        else input.pause();
      } catch (cause) {
        error ??= cause;
      }
      try {
        clear();
      } catch (cause) {
        error ??= cause;
      }
      try {
        output.write('\u001b[?25h');
      } catch (cause) {
        error ??= cause;
      }
      if (error !== undefined) reject(error);
      else resolve(value);
    }

    /** Рисует разделённые блоки с белым активным текстом и цветным значком; сокращает текст до ANSI. */
    function render() {
      if (closed) return;
      try {
        const width = Math.max(0, (output.columns ?? 80) - 1);
        const height = Math.max(0, (output.rows ?? 24) - 1);
        const lines: string[] = [];
        const formatted: string[] = [];
        const add = (
          text: string,
          format?: Parameters<typeof styleText>[0] | ((line: string) => string),
        ) => {
          const line = truncateTerminalText(text, width);
          lines.push(line);
          formatted.push(
            typeof format === 'function'
              ? format(line)
              : format
                ? styleText(format, line, { stream: output })
                : line,
          );
        };
        const section = (title: string) => {
          const prefix = `├─ ${title} `;
          add(prefix + '─'.repeat(Math.max(0, width - stringWidth(prefix))), ['bold', 'gray']);
        };
        const fixedRows = locked.length + 11;
        canSubmit = width >= 24 && height >= fixedRows + 1;
        if (!canSubmit) {
          if (height > 0) add('Увеличьте окно терминала');
          if (height > 1) add('Esc / Ctrl+C — отмена');
        } else {
          add(`${S_STEP_ACTIVE} ${options.message}`, 'bold');
          add(`${S_BAR} Общая папка: ${terminalText(options.sharedDirectory)}`, 'gray');
          section('Всегда включены');
          for (const item of locked)
            add(`${S_BAR} ✓ ${terminalText(item.label)}`, (line) =>
              formatChoice(line, '✓', false, true, output),
            );
          section('Дополнительные агенты');
          const prefix = `${S_BAR} Поиск: `;
          const queryWidth = width - stringWidth(prefix) - 1;
          const segments = [
            ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(query),
          ].map((part) => part.segment);
          let tail = '';
          while (segments.length && stringWidth(segments.at(-1)! + tail) <= queryWidth - 1)
            tail = segments.pop()! + tail;
          add(`${prefix}${segments.length ? '…' : ''}${tail}█`);
          const items = filtered();
          const count = Math.min(8, height - fixedRows, Math.max(1, items.length));
          const start = Math.max(0, Math.min(cursor - Math.floor(count / 2), items.length - count));
          if (!items.length) add(`${S_BAR} Совпадений нет`, 'gray');
          else
            for (let index = start; index < Math.min(items.length, start + count); index++) {
              const item = items[index]!;
              const mark = selected.has(item.value) ? S_CHECKBOX_SELECTED : S_CHECKBOX_INACTIVE;
              add(
                `${S_BAR} ${index === cursor ? '›' : ' '} ${mark} ${terminalText(item.label)}${item.hint ? ` (${terminalText(item.hint)})` : ''}`,
                (line) =>
                  formatChoice(line, mark, index === cursor, selected.has(item.value), output),
              );
            }
          section('Итог');
          add(
            `${S_BAR} Выбрано: ${chosen()
              .map((item) => terminalText(item.label))
              .join(', ')}`,
          );
          add(`${S_BAR} ↑↓ — курсор · пробел — выбор`, 'gray');
          add(`${S_BAR} Enter — подтвердить · Esc/Ctrl+C — отмена`, 'gray');
          add(S_BAR_END + '─'.repeat(Math.max(0, width - stringWidth(S_BAR_END))), 'gray');
        }
        clear();
        previousLines = lines;
        if (lines.length) output.write(formatted.join('\n') + '\n');
      } catch (cause) {
        finish(null, cause);
      }
    }

    /** Обрабатывает фильтр и отметки; поиск не изменяет набор выбранных значений. */
    function onKey(character: string | undefined, key: Key) {
      if (closed) return;
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        finish(null);
        return;
      }
      if (key.name === 'return') {
        if (canSubmit) finish(chosen().map((item) => item.value));
        return;
      }
      const items = filtered();
      if (key.name === 'up' || key.name === 'down') {
        cursor = Math.max(0, Math.min(items.length - 1, cursor + (key.name === 'up' ? -1 : 1)));
      } else if (key.name === 'space') {
        const item = items[cursor];
        if (item) {
          if (selected.has(item.value)) selected.delete(item.value);
          else selected.add(item.value);
        }
      } else if (key.name === 'backspace') {
        const segments = [
          ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(query),
        ];
        query = query.slice(0, segments.at(-1)?.index ?? 0);
        cursor = 0;
      } else if (key.ctrl && key.name === 'u') {
        query = '';
        cursor = 0;
      } else if (character && !key.ctrl && !key.meta && !/\p{Cc}/u.test(character)) {
        query += character;
        cursor = 0;
      }
      render();
    }
    function onEnd() {
      finish(null);
    }
    function onError(error: Error) {
      finish(null, error);
    }
    /** Пересчитывает физическую высоту старого кадра после изменения ширины терминала. */
    function onResize() {
      const width = Math.max(1, output.columns ?? 80);
      previousLines = previousLines.flatMap((line) =>
        Array.from({ length: Math.max(1, Math.ceil(stringWidth(line) / width)) }, () => ''),
      );
      render();
    }

    try {
      emitKeypressEvents(input);
      input.on('keypress', onKey);
      input.on('end', onEnd);
      input.on('close', onEnd);
      input.on('error', onError);
      output.on('error', onError);
      output.on('resize', onResize);
      input.setRawMode?.(true);
      input.resume();
      output.write('\u001b[?25l');
      render();
    } catch (cause) {
      finish(null, cause);
    }
  });
}
