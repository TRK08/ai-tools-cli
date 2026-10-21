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
import type { RegistryClient } from '../registry/client.ts';
import type { CatalogSkill } from '../registry/catalog.ts';
import type { PromptStreams } from './terminal/types.ts';
import { terminalText, queryViewport } from './terminal/text.ts';
import { MIN_FIND_PREFIX_LENGTH, RegistryFindSearch } from './find-search.ts';
import { plural } from './labels.ts';
import { createLoading } from './terminal/loading.ts';
import { formatChoice } from './terminal/style.ts';
import { runPrompt } from './terminal/prompt.ts';
import { createFrame } from './terminal/screen.ts';
import { moveSelection, visibleStart } from './terminal/navigation.ts';

// Адаптировано из ../skills/src/find.ts; см. ThirdPartyNoticeText.txt.
/** Форматирует счётчик установок с русским склонением и сокращениями тыс./млн. */
function installs(count: number): string {
  const value =
    count >= 1_000_000
      ? `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '').replace('.', ',')} млн`
      : count >= 1_000
        ? `${(count / 1_000).toFixed(1).replace(/\.0$/, '').replace('.', ',')} тыс.`
        : String(count);
  return `${value} ${count >= 1_000 ? 'установок' : plural(count, 'установка', 'установки', 'установок')}`;
}

/**
 * Ведёт асинхронный выбор registry-скилла с редактированием префикса и прокруткой.
 *
 * @returns Полный объект результата либо null при отмене/закрытии потоков.
 * @remarks Ошибка setup/render/потока отклоняет Promise после очистки; исходная причина сохраняется.
 * По завершении отменяет поиск и spinner, восстанавливает raw mode, поток и курсор.
 */
export async function selectRegistrySkill(
  client: RegistryClient,
  initialPrefix: string,
  streams: PromptStreams,
): Promise<CatalogSkill | null> {
  return runPrompt<CatalogSkill>(streams, (prompt) => {
    let selectedIndex = 0,
      cursor = [...initialPrefix].length;
    let query = [...initialPrefix];
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
    const search = new RegistryFindSearch(client, () => {
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
        add(`${S_STEP_ACTIVE} Найдите скилл для установки · префикс slug`, 'bold');
        const queryLabel = `${S_BAR} Префикс slug: `;
        const prefix = queryViewport(
          terminalText(query.slice(0, cursor).join('')),
          terminalText(query.slice(cursor).join('')),
          width - stringWidth(queryLabel),
        );
        add(`${queryLabel}${query.length ? prefix : 'Введите префикс slug…'}`, (line) =>
          query.length
            ? line
            : line.slice(0, queryLabel.length) +
              styleText('gray', line.slice(queryLabel.length), { stream: streams.output }),
        );
        const state = search.state;
        if (state.status !== 'ready' || !state.items.length) section('Результаты');
        if (state.status === 'idle')
          add(`${S_BAR} Для поиска введите от ${MIN_FIND_PREFIX_LENGTH} символов.`, 'gray');
        else if (state.status === 'loading')
          add(`${S_BAR} ${loadingLine ?? 'Поиск в реестре…'}`, 'gray');
        else if (state.status === 'error') {
          add(`${S_BAR} Не удалось выполнить поиск: ${terminalText(state.message)}`);
        } else if (!state.items.length)
          add(`${S_BAR} Скиллы с таким префиксом не найдены.`, 'gray');
        else {
          const count = Math.min(8, maximum - fixedRows, state.items.length);
          const start = visibleStart(selectedIndex, count, state.items.length);
          section(`Совпадений: ${state.items.length} · ${start + 1}–${start + count}`);
          for (let i = start; i < Math.min(start + count, state.items.length); i++) {
            const skill = state.items[i]!,
              selected = i === selectedIndex;
            const marker = selected ? S_RADIO_ACTIVE : S_RADIO_INACTIVE;
            add(
              `${S_BAR} ${marker} ${skill.slug}@${skill.currentVersion} · ${installs(skill.installCount)}`,
              (line) => formatChoice(line, marker, selected, false, streams.output),
            );
          }
        }
        section('Управление');
        if (expandedHelp) {
          add(
            `${S_BAR} ${state.status === 'error' ? 'Enter — повторить поиск; или измените префикс.' : '↑/↓ — выбор · Enter — установить'}`,
            'gray',
          );
          add(
            `${S_BAR} ${state.status === 'error' ? 'Esc / Ctrl+C — отмена' : 'Введите префикс slug · Esc/Ctrl+C — отмена'}`,
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
      if (query.join('') !== before) search.setPrefix(query.join(''));
    }
    return {
      key: onKey,
      render,
      start() {
        intro('Поиск скиллов', { output: streams.output });
        search.setPrefix(initialPrefix, true);
      },
      cleanup: [() => search.close(), () => loading.stop()],
    };
  });
}
