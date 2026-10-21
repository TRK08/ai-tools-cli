import { S_BAR, S_RADIO_ACTIVE, S_RADIO_INACTIVE, S_STEP_ACTIVE, symbol } from '@clack/prompts';
import { runPrompt } from './prompt.ts';
import { wrapTerminalText, terminalText } from './text.ts';
import { formatChoice } from './style.ts';
import type { SelectOptions, ConfirmOptions } from './types.ts';
import { createFrame } from './screen.ts';
import { moveSelection, navigationKey } from './navigation.ts';

/** Выбирает одно значение, сохраняя финальный кадр; EOF/отмена дают null после восстановления TTY. */
export function select<Value>(options: SelectOptions<Value>): Promise<Value | null> {
  return runPrompt<Value>(
    options,
    (prompt) => {
      let selected = Math.max(
        0,
        options.options.findIndex((item) => item.value === options.initialValue),
      );
      let canSubmit = false;
      return {
        render() {
          const frame = createFrame(options.output);
          const width = Math.max(1, frame.width);
          const lines = [
            ...wrapTerminalText(`${S_STEP_ACTIVE} ${options.message}`, width),
            ...options.options.flatMap((choice, index) => {
              const active = index === selected;
              const marker = active ? S_RADIO_ACTIVE : S_RADIO_INACTIVE;
              return wrapTerminalText(
                `${S_BAR} ${marker} ${terminalText(choice.label)}`,
                width,
              ).map((line) => formatChoice(line, marker, active, false, options.output));
            }),
          ];
          canSubmit = frame.width >= 12 && lines.length <= frame.height;
          if (canSubmit) prompt.screen.write(lines);
          else {
            if (frame.height > 0) frame.add('Увеличьте окно терминала');
            if (frame.height > 1) frame.add('Esc / Ctrl+C — отмена');
            prompt.screen.write(frame.lines);
          }
        },
        key(value, key) {
          const action = navigationKey(key, options.confirmation === 'submit');
          if (key.name === 'return') {
            if (canSubmit) prompt.finish(options.options[selected]!.value);
            return;
          }
          if (['up', 'left'].includes(action ?? ''))
            selected = moveSelection(selected, -1, options.options.length, true);
          else if (['down', 'right', 'tab', 'space'].includes(action ?? ''))
            selected = moveSelection(selected, 1, options.options.length, true);
          else if (options.confirmation && ['y', 'n'].includes(value?.toLowerCase() ?? '')) {
            selected = value!.toLowerCase() === 'y' ? 0 : 1;
            if (options.confirmation === 'submit' && canSubmit)
              return prompt.finish(options.options[selected]!.value);
          }
          prompt.render();
        },
        settled(value) {
          if (!options.summary) return;
          const width = Math.max(1, (options.output.columns ?? 80) - 4);
          prompt.screen.write([
            S_BAR,
            ...wrapTerminalText(options.message, width).map(
              (line, index) =>
                `${index ? S_BAR : symbol(value === null ? 'cancel' : 'submit')}  ${line}`,
            ),
            `${S_BAR}  ${terminalText(options.options[selected]!.label)}`,
          ]);
        },
      };
    },
    { ...(options.signal === undefined ? {} : { signal: options.signal }), clearOnExit: false },
  );
}

/**
 * Подтверждает действие с предвыбранным «Нет»; null отличает отмену от отрицательного ответа.
 * Y/N отвечают сразу; submitOnKey=false только перемещает выбор до Enter (add).
 */
export function confirm(options: ConfirmOptions): Promise<boolean | null> {
  return select({
    ...options,
    options: [
      { value: true, label: options.active },
      { value: false, label: options.inactive },
    ],
    initialValue: false,
    confirmation: options.submitOnKey === false ? 'select' : 'submit',
    summary: options.summary ?? true,
  });
}
