import { MultiSelectPrompt } from '@clack/core';
import {
  limitOptions,
  S_BAR,
  S_BAR_END,
  S_CHECKBOX_ACTIVE,
  S_CHECKBOX_INACTIVE,
  S_CHECKBOX_SELECTED,
  symbol,
  type Option,
} from '@clack/prompts';
import { styleText } from 'node:util';
import type { PromptStreams } from './agents-prompt.ts';
import { wrapTerminalText } from './table.ts';

/**
 * Открывает множественный выбор Clack с русской отрисовкой и запретом пустого выбора. Навигацию и отмену
 * выполняет штатное ядро MultiSelectPrompt.
 */
export function multiselect<Value>(
  options: PromptStreams & {
    readonly message: string;
    readonly options: Option<Value>[];
    readonly initialValues: Value[];
    readonly maxItems?: number;
  },
) {
  return new MultiSelectPrompt({
    ...options,
    required: true,
    validate: (selected) =>
      selected?.length
        ? undefined
        : 'Выберите хотя бы один пункт. Пробел — выбор, Enter — подтверждение.',
    render() {
      const width = Math.max(12, (options.output.columns ?? 80) - 4);
      const heading = wrapTerminalText(options.message, width).map(
        (line, index) => `${index ? S_BAR : symbol(this.state)}  ${line}`,
      );
      const selected = this.value ?? [];
      const lines = [`${S_BAR}`, ...heading];
      if (this.state === 'submit' || this.state === 'cancel') {
        lines.push(
          `${S_BAR}  ${this.options
            .filter((option) => selected.includes(option.value))
            .map((option) => option.label ?? String(option.value))
            .join(', ')}`,
        );
      } else {
        lines.push(
          ...limitOptions({
            output: options.output,
            options: this.options,
            cursor: this.cursor,
            ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
            columnPadding: 3,
            rowPadding:
              lines.length +
              (this.state === 'error' ? wrapTerminalText(this.error, width).length : 0) +
              2,
            style: (option, active) => {
              const checked = selected.includes(option.value);
              const marker = checked
                ? S_CHECKBOX_SELECTED
                : active
                  ? S_CHECKBOX_ACTIVE
                  : S_CHECKBOX_INACTIVE;
              const text = `${marker} ${option.label ?? String(option.value)}${option.hint ? ` (${option.hint})` : ''}`;
              return styleText(active ? 'cyan' : checked ? 'green' : 'dim', text);
            },
          }).map((line) => `${S_BAR}  ${line}`),
        );
        if (this.state === 'error')
          lines.push(
            ...wrapTerminalText(this.error, width).map(
              (line) => `${S_BAR}  ${styleText('yellow', line)}`,
            ),
          );
        lines.push(S_BAR_END);
      }
      return lines.join('\n') + '\n';
    },
  }).prompt();
}
