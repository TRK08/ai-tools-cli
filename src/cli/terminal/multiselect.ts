import {
  S_BAR,
  S_BAR_END,
  S_CHECKBOX_ACTIVE,
  S_CHECKBOX_SELECTED,
  S_CHECKBOX_INACTIVE,
  S_STEP_ACTIVE,
  symbol,
} from '@clack/prompts';
import { runPrompt } from './prompt.ts';
import { createFrame } from './screen.ts';
import { formatChoice } from './style.ts';
import { terminalText, queryViewport, wrapTerminalText } from './text.ts';
import stringWidth from 'fast-string-width';
import { moveSelection, visibleStart, navigationKey } from './navigation.ts';
import type { MultiselectOptions } from './types.ts';

/**
 * Выбирает несколько значений с необязательными фильтром и закреплёнными вариантами.
 * Сохраняет отметки при фильтрации, возвращает значения в порядке входных списков;
 * отмена/EOF дают null. Поисковый кадр очищается, обычный сохраняет итог выбора.
 * Владение TTY, ошибки и AbortSignal обслуживает общий runPrompt.
 */
export function multiselect<Value>(options: MultiselectOptions<Value>): Promise<Value[] | null> {
  return runPrompt<Value[]>(
    options,
    (prompt) => {
      const locked = options.locked ?? [];
      const selected = new Set(options.initialValues ?? []);
      let query = '',
        cursor = 0,
        error = '',
        canSubmit = false;
      const filtered = () =>
        options.options.filter(
          (item) =>
            item.label.toLowerCase().includes(query.toLowerCase()) ||
            String(item.value).toLowerCase().includes(query.toLowerCase()),
        );
      const chosen = () => [
        ...locked,
        ...options.options.filter((item) => selected.has(item.value)),
      ];
      const render = () => {
        const frame = createFrame(options.output);
        const { width, height, add, section } = frame;
        const heading = wrapTerminalText(options.message, Math.max(1, width - 3));
        const errors = error ? wrapTerminalText(error, Math.max(1, width - 3)) : [];
        const context = options.context ?? [];
        const fixedRows = options.search
          ? locked.length + context.length + 10
          : heading.length + errors.length + 2;
        canSubmit = width >= (options.search ? 24 : 12) && height >= fixedRows + 1;
        if (!canSubmit) {
          if (height > 0) add('Увеличьте окно терминала');
          if (height > 1) add('Esc / Ctrl+C — отмена');
        } else {
          if (options.search) {
            add(`${S_STEP_ACTIVE} ${options.message}`, 'bold');
            for (const line of context) add(`${S_BAR} ${terminalText(line)}`, 'gray');
            section(options.lockedLabel ?? 'Закреплённые варианты');
            for (const item of locked)
              add(`${S_BAR} ✓ ${terminalText(item.label)}`, (line) =>
                formatChoice(line, '✓', false, true, options.output),
              );
            section(options.optionsLabel ?? 'Варианты');
            const prefix = `${S_BAR} Поиск: `;
            add(`${prefix}${queryViewport(terminalText(query), '', width - stringWidth(prefix))}`);
          } else {
            add(S_BAR);
            heading.forEach((line, index) => add(`${index ? S_BAR : S_STEP_ACTIVE}  ${line}`));
          }
          const items = filtered();
          const count = Math.min(
            options.maxItems ?? 8,
            height - fixedRows,
            Math.max(1, items.length),
          );
          const start = visibleStart(cursor, count, items.length);
          if (!items.length) add(`${S_BAR} Совпадений нет`, 'gray');
          for (let index = start; index < Math.min(start + count, items.length); index++) {
            const item = items[index]!,
              active = index === cursor,
              checked = selected.has(item.value);
            const marker = checked
              ? S_CHECKBOX_SELECTED
              : active && !options.search
                ? S_CHECKBOX_ACTIVE
                : S_CHECKBOX_INACTIVE;
            const label = `${marker} ${terminalText(item.label)}${item.hint ? ` (${terminalText(item.hint)})` : ''}`;
            add(`${S_BAR} ${options.search ? `${active ? '›' : ' '} ` : ' '}${label}`, (line) =>
              formatChoice(line, marker, active, checked, options.output),
            );
          }
          if (options.search) {
            section('Итог');
            add(
              `${S_BAR} Выбрано: ${chosen()
                .map((item) => terminalText(item.label))
                .join(', ')}`,
            );
            add(`${S_BAR} ↑↓ — курсор · пробел — выбор`, 'gray');
            add(`${S_BAR} Enter — подтвердить · Esc/Ctrl+C — отмена`, 'gray');
            add(S_BAR_END + '─'.repeat(Math.max(0, width - 1)), 'gray');
          } else {
            errors.forEach((line) => add(`${S_BAR}  ${line}`));
            add(S_BAR_END);
          }
        }
        prompt.screen.write(frame.lines);
      };
      return {
        render,
        key(character, key) {
          if (key.name === 'return') {
            if (!canSubmit) return;
            const values = chosen().map((item) => item.value);
            if (options.required && !values.length) {
              error = 'Выберите хотя бы один пункт. Пробел — выбор, Enter — подтверждение.';
              prompt.render();
            } else prompt.finish(values);
            return;
          }
          const items = filtered();
          const action = navigationKey(key, !options.search);
          if (['up', 'down', 'left', 'right', 'tab'].includes(action ?? ''))
            cursor = moveSelection(
              cursor,
              ['up', 'left'].includes(action ?? '') || key.shift ? -1 : 1,
              items.length,
              !options.search,
            );
          else if (key.name === 'space') {
            const item = items[cursor];
            if (item) {
              if (selected.has(item.value)) selected.delete(item.value);
              else selected.add(item.value);
              error = '';
            }
          } else if (!options.search && ['a', 'i'].includes(key.name ?? '')) {
            const allSelected = options.options.every((item) => selected.has(item.value));
            for (const item of options.options) {
              const remove = key.name === 'a' ? allSelected : selected.has(item.value);
              if (remove) selected.delete(item.value);
              else selected.add(item.value);
            }
            error = '';
          } else if (options.search) {
            if (key.name === 'backspace') {
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
          }
          prompt.render();
        },
        settled(value) {
          if (options.search) return;
          const width = Math.max(1, (options.output.columns ?? 80) - 4);
          prompt.screen.write([
            S_BAR,
            ...wrapTerminalText(options.message, width).map(
              (line, index) =>
                `${index ? S_BAR : symbol(value === null ? 'cancel' : 'submit')}  ${line}`,
            ),
            `${S_BAR}  ${chosen()
              .map((item) => terminalText(item.label))
              .join(', ')}`,
          ]);
        },
      };
    },
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      clearOnExit: !!options.search,
    },
  );
}
