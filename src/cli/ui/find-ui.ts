import {
  intro,
  S_BAR,
  S_BAR_END,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  S_STEP_ACTIVE,
} from '@clack/prompts';
import type { Key } from 'node:readline';
import { styleText } from 'node:util';
import stringWidth from 'fast-string-width';
import type { FindSearchFactory } from './types';
import type { CatalogSkill } from '@/registry';
import {
  type PromptStreams,
  terminalText,
  queryViewport,
  createLoading,
  formatChoice,
  runPrompt,
  createFrame,
  moveSelection,
  visibleStart,
} from '@/cli/terminal';
/**
 * Ведёт асинхронный выбор registry-скилла с редактированием запроса и прокруткой.
 *
 * @returns Полный объект результата либо null при отмене/закрытии потоков.
 * @remarks Ошибка setup/render/потока отклоняет Promise после очистки; исходная причина сохраняется.
 * По завершении отменяет поиск и spinner, восстанавливает raw mode, поток и курсор.
 */
export async function selectRegistrySkill(
  createSearch: FindSearchFactory,
  initialQuery: string,
  streams: PromptStreams,
): Promise<CatalogSkill | null> {
  return runPrompt<CatalogSkill>(streams, (prompt) => {
    let selectedIndex = 0,
      cursor = [...initialQuery].length;
    let query = [...initialQuery];
    let loadingLine: string | null = null;
    let canSubmit = false;
    const loading = createLoading(
      streams,
      (line) => {
        loadingLine = line;
        prompt.render();
      },
      (cause) => prompt.finish(null, cause),
    );
    const search = createSearch(() => {
      if (prompt.closed) return;
      try {
        selectedIndex = 0;
        if (search.state.status === 'loading') loading.start('Поиск в реестре…');
        else loading.stop();
        prompt.render();
      } catch (cause) {
        prompt.finish(null, cause);
      }
    });
    /** Разделяет запрос, результаты и управление; цвет оставляет только у значка выбранного пункта. */
    function render() {
      const frame = createFrame(streams.output);
      const { width, height: maximum, add, section } = frame;
      const expandedHelp = maximum >= 9 && width >= 42;
      const fixedRows = expandedHelp ? 7 : 6;
      canSubmit = width >= 18 && maximum >= fixedRows + 1;
      if (!canSubmit) {
        if (maximum > 0 && width > 0) add('Увеличьте окно терминала');
        if (maximum > 1 && width > 0) add('Esc / Ctrl+C — отмена');
      } else {
        add(`${S_STEP_ACTIVE} Найдите скилл для установки`, 'bold');
        const queryLabel = `${S_BAR} Запрос: `;
        const prefix = queryViewport(
          terminalText(query.slice(0, cursor).join('')),
          terminalText(query.slice(cursor).join('')),
          width - stringWidth(queryLabel),
        );
        add(`${queryLabel}${query.length ? prefix : 'Введите запрос…'}`, (line) =>
          query.length
            ? line
            : line.slice(0, queryLabel.length) +
              styleText('gray', line.slice(queryLabel.length), { stream: streams.output }),
        );
        const state = search.state;
        if (state.status !== 'ready' || !state.items.length) section('Результаты');
        if (state.status === 'idle') add(`${S_BAR} Введите минимум 3 символа.`, 'gray');
        else if (state.status === 'loading')
          add(`${S_BAR} ${loadingLine ?? 'Поиск в реестре…'}`, 'gray');
        else if (state.status === 'error') {
          add(`${S_BAR} Не удалось выполнить поиск: ${terminalText(state.message)}`);
        } else if (!state.items.length) add(`${S_BAR} Скиллы не найдены.`, 'gray');
        else {
          const count = Math.min(8, maximum - fixedRows, state.items.length);
          const start = visibleStart(selectedIndex, count, state.items.length);
          section(
            `Найдено: ${state.total} · Показано: ${state.items.length} · ${start + 1}–${start + count}`,
          );
          for (let i = start; i < Math.min(start + count, state.items.length); i++) {
            const skill = state.items[i]!,
              selected = i === selectedIndex;
            const marker = selected ? S_RADIO_ACTIVE : S_RADIO_INACTIVE;
            add(
              `${S_BAR} ${marker} ${skill.name} · ${skill.packageSlug}@${skill.version}`,
              (line) => formatChoice(line, marker, selected, false, streams.output),
            );
          }
        }
        section('Управление');
        if (expandedHelp) {
          add(
            `${S_BAR} ${state.status === 'error' ? 'Enter — повторить поиск; или измените запрос.' : '↑/↓ — выбор · Enter — установить'}`,
            'gray',
          );
          add(
            `${S_BAR} ${state.status === 'error' ? 'Esc / Ctrl+C — отмена' : 'Введите запрос · Esc/Ctrl+C — отмена'}`,
            'gray',
          );
        } else
          add(`${S_BAR} ${state.status === 'error' ? 'Enter · Esc' : '↑↓ · Enter · Esc'}`, 'gray');
        add(S_BAR_END + '─'.repeat(Math.max(0, width - stringWidth(S_BAR_END))), 'gray');
      }
      prompt.screen.write(frame.lines);
    }

    /** Обрабатывает редактирование, выбор, retry и отмену; Enter принимает только доступный результат. */
    function onKey(character: string | undefined, key: Key) {
      if (prompt.closed) return;
      if (key.name === 'return') {
        if (!canSubmit) return;
        if (search.state.status === 'error') search.retry();
        else if (search.state.status === 'ready' && search.state.items[selectedIndex])
          prompt.finish(search.state.items[selectedIndex]!);
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        if (search.state.status === 'ready' && search.state.items.length)
          selectedIndex = moveSelection(
            selectedIndex,
            key.name === 'up' ? -1 : 1,
            search.state.items.length,
          );
        prompt.render();
        return;
      }
      if (key.name === 'left') {
        cursor = Math.max(0, cursor - 1);
        prompt.render();
        return;
      }
      if (key.name === 'right') {
        cursor = Math.min(query.length, cursor + 1);
        prompt.render();
        return;
      }
      if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
        cursor = 0;
        prompt.render();
        return;
      }
      if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
        cursor = query.length;
        prompt.render();
        return;
      }
      const before = query.join('');
      if (key.ctrl && key.name === 'u') {
        query = [];
        cursor = 0;
      } else if (key.name === 'backspace' && cursor > 0) query.splice(--cursor, 1);
      else if (key.name === 'delete' && cursor < query.length) query.splice(cursor, 1);
      else if (character && !key.ctrl && !key.meta && !/\p{Cc}/u.test(character)) {
        const parts = [...character];
        query.splice(cursor, 0, ...parts);
        cursor += parts.length;
      }
      if (query.join('') !== before) search.setQuery(query.join(''));
    }
    return {
      key: onKey,
      render,
      start() {
        intro('Поиск скиллов', { output: streams.output });
        search.setQuery(initialQuery, true);
      },
      cleanup: [() => search.close(), () => loading.stop()],
    };
  });
}
