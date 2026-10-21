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
import type { PromptStreams } from './agents-prompt.ts';
import { terminalText } from './discovery-ui.ts';
import { MIN_FIND_PREFIX_LENGTH, RegistryFindSearch } from './find-search.ts';
import { truncateTerminalText } from './table.ts';
import { plural } from './labels.ts';
import { createLoading } from './loading.ts';
import { formatChoice } from './selection-style.ts';
import { terminalSession } from './terminal-session.ts';

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

/** Показывает участок запроса вокруг курсора, сохраняя целые графемы и исходный HTTP-префикс. */
function queryViewport(before: string, after: string, width: number): string {
  const segments = [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(before),
  ].map((item) => item.segment);
  let tail = '';
  while (segments.length && stringWidth(segments.at(-1)! + tail) <= width - 2) {
    tail = segments.pop()! + tail;
  }
  const prefix = (segments.length ? '…' : '') + tail + '█';
  return prefix + truncateTerminalText(after, width - stringWidth(prefix));
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
  if (
    streams.input.destroyed ||
    streams.input.readableEnded ||
    streams.output.destroyed ||
    streams.output.writableEnded
  )
    return null;
  return new Promise((resolve, reject) => {
    let closed = false,
      selectedIndex = 0,
      cursor = [...initialPrefix].length;
    let query = [...initialPrefix];
    let previousLines: string[] = [];
    let loadingLine: string | null = null;
    let canSubmit = false;
    const loading = createLoading(
      streams,
      (line) => {
        loadingLine = line;
        render();
      },
      (cause) => finish(null, cause),
    );
    const search = new RegistryFindSearch(client, () => {
      if (closed) return;
      try {
        selectedIndex = 0;
        if (search.state.status === 'loading') loading.start('Поиск в реестре…');
        else loading.stop();
        render();
      } catch (cause) {
        finish(null, cause);
      }
    });
    const session = terminalSession(streams, {
      key: onKey,
      end: onEnd,
      error: (cause) => finish(null, cause),
      resize: onResize,
    });

    /** Стирает только строки предыдущего кадра, чтобы повторная отрисовка не оставляла старые варианты. */
    const clear = () => {
      if (previousLines.length) streams.output.write(`\u001b[${previousLines.length}A\r\u001b[J`);
      previousLines = [];
    };
    /** Завершает выбор один раз и освобождает поиск и терминал перед resolve/reject. */
    const finish = (skill: CatalogSkill | null, error?: unknown) => {
      if (closed) return;
      closed = true;
      for (const cleanup of [
        () => search.close(),
        () => loading.stop(),
        clear,
        () => {
          if (!streams.output.destroyed && !streams.output.writableEnded)
            streams.output.write('\u001b[?25h');
        },
      ]) {
        try {
          cleanup();
        } catch (cause) {
          error ??= cause;
        }
      }
      const cleanupError = session.close();
      error ??= cleanupError;
      if (error !== undefined) reject(error);
      else resolve(skill);
    };

    /** Разделяет запрос, результаты и управление; цвет оставляет только у значка выбранного пункта. */
    function render() {
      if (closed) return;
      try {
        const width = Math.max(0, (streams.output.columns ?? 80) - 1);
        const maximum = Math.max(0, (streams.output.rows ?? 24) - 1);
        const expandedHelp = maximum >= 9 && width >= 42;
        const fixedRows = expandedHelp ? 7 : 6;
        canSubmit = width >= 18 && maximum >= fixedRows + 1;
        const body: string[] = [];
        const formatted: string[] = [];
        const add = (
          text: string,
          format?: Parameters<typeof styleText>[0] | ((line: string) => string),
        ) => {
          const line = truncateTerminalText(text, width);
          body.push(line);
          formatted.push(
            typeof format === 'function'
              ? format(line)
              : format
                ? styleText(format, line, { stream: streams.output })
                : line,
          );
        };
        const section = (title: string) => {
          const prefix = `├─ ${title} `;
          add(prefix + '─'.repeat(Math.max(0, width - stringWidth(prefix))), ['bold', 'gray']);
        };
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
            const start = Math.max(
              0,
              Math.min(selectedIndex - Math.floor(count / 2), state.items.length - count),
            );
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
            add(
              `${S_BAR} ${state.status === 'error' ? 'Enter · Esc' : '↑↓ · Enter · Esc'}`,
              'gray',
            );
          add(S_BAR_END + '─'.repeat(Math.max(0, width - stringWidth(S_BAR_END))), 'gray');
        }
        clear();
        previousLines = body;
        if (previousLines.length) streams.output.write(formatted.join('\n') + '\n');
      } catch (cause) {
        finish(null, cause);
      }
    }

    /** Обрабатывает редактирование, выбор, retry и отмену; Enter принимает только доступный результат. */
    function onKey(character: string | undefined, key: Key) {
      if (closed) return;
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        finish(null);
        return;
      }
      if (key.name === 'return') {
        if (!canSubmit) return;
        if (search.state.status === 'error') search.retry();
        else if (search.state.status === 'ready' && search.state.items[selectedIndex])
          finish(search.state.items[selectedIndex]!);
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        if (search.state.status === 'ready' && search.state.items.length)
          selectedIndex = Math.max(
            0,
            Math.min(selectedIndex + (key.name === 'up' ? -1 : 1), search.state.items.length - 1),
          );
        render();
        return;
      }
      if (key.name === 'left') {
        cursor = Math.max(0, cursor - 1);
        render();
        return;
      }
      if (key.name === 'right') {
        cursor = Math.min(query.length, cursor + 1);
        render();
        return;
      }
      if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
        cursor = 0;
        render();
        return;
      }
      if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
        cursor = query.length;
        render();
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
    /** Завершает выбор отменой при закрытии входного потока. */
    function onEnd() {
      finish(null);
    }
    /** Учитывает физический перенос старого кадра после resize, затем перерисовывает меню. */
    function onResize() {
      const width = Math.max(1, streams.output.columns ?? 80);
      previousLines = previousLines.flatMap((line) =>
        Array.from({ length: Math.max(1, Math.ceil(stringWidth(line) / width)) }, () => ''),
      );
      render();
    }
    try {
      session.start();
      intro('Поиск скиллов', { output: streams.output });
      streams.output.write('\u001b[?25l');
      search.setPrefix(initialPrefix, true);
    } catch (cause) {
      finish(null, cause);
    }
  });
}
