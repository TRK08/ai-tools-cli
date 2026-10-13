import {
  intro,
  S_BAR,
  S_BAR_END,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  S_STEP_ACTIVE,
} from '@clack/prompts';
import { emitKeypressEvents, type Key } from 'node:readline';
import { styleText } from 'node:util';
import stringWidth from 'fast-string-width';
import type { RegistryClient } from '../registry/client.ts';
import type { CatalogSkill } from '../registry/catalog.ts';
import type { PromptStreams } from './agents-prompt.ts';
import { terminalText } from './discovery-ui.ts';
import { MIN_FIND_PREFIX_LENGTH, RegistryFindSearch } from './find-search.ts';
import { truncateTerminalText } from './table.ts';
import { plural } from './labels.ts';

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
 * @returns Полный объект выбранного результата либо null при отмене/закрытии stdin.
 * @remarks По завершении отменяет поиск, снимает обработчики и восстанавливает raw mode и курсор.
 */
export async function selectRegistrySkill(
  client: RegistryClient,
  initialPrefix: string,
  streams: PromptStreams,
): Promise<CatalogSkill | null> {
  intro('Поиск скиллов', { output: streams.output });
  return new Promise((resolve, reject) => {
    let closed = false,
      selectedIndex = 0,
      cursor = [...initialPrefix].length;
    let query = [...initialPrefix];
    let previousLines: string[] = [];
    let canSubmit = false;
    const previousRaw = streams.input.isRaw ?? false;
    const search = new RegistryFindSearch(client, () => {
      selectedIndex = 0;
      render();
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
      search.close();
      streams.input.off('keypress', onKey);
      streams.input.off('end', onEnd);
      streams.output.off('resize', onResize);
      streams.input.setRawMode?.(previousRaw);
      streams.input.pause();
      try {
        clear();
        streams.output.write('\u001b[?25h');
      } catch (cause) {
        error ??= cause;
      }
      if (error !== undefined) reject(error);
      else resolve(skill);
    };

    /** Рисует текущий кадр с видимым выбранным пунктом; в маленьком окне запрещает подтверждение. */
    function render() {
      if (closed) return;
      try {
        const width = Math.max(0, (streams.output.columns ?? 80) - 3);
        const maximum = Math.max(0, (streams.output.rows ?? 24) - 1);
        canSubmit = width >= 16 && maximum >= 6;
        const body: string[] = [];
        const add = (text: string) => {
          body.push(truncateTerminalText(text, width));
        };
        if (!canSubmit) {
          if (maximum > 0 && width > 0) add('Увеличьте окно терминала');
          if (maximum > 1 && width > 0) add('Esc / Ctrl+C — отмена');
        } else {
          add(`${S_STEP_ACTIVE} Найдите скилл для установки · префикс slug`);
          const prefix = queryViewport(
            terminalText(query.slice(0, cursor).join('')),
            terminalText(query.slice(cursor).join('')),
            width - stringWidth('Префикс slug: '),
          );
          add(`Префикс slug: ${query.length ? prefix : 'Введите префикс slug…'}`);
          const state = search.state;
          if (state.status === 'idle')
            add(`Для поиска введите от ${MIN_FIND_PREFIX_LENGTH} символов.`);
          else if (state.status === 'loading') add('Поиск в реестре…');
          else if (state.status === 'error') {
            add(`Не удалось выполнить поиск: ${terminalText(state.message)}`);
            add('Enter — повторить поиск; или измените префикс.');
          } else if (!state.items.length) add('Скиллы с таким префиксом не найдены.');
          else {
            const count = Math.min(8, maximum - 5, state.items.length);
            const start = Math.max(
              0,
              Math.min(selectedIndex - Math.floor(count / 2), state.items.length - count),
            );
            add(`Совпадений: ${state.items.length} · ${start + 1}–${start + count}`);
            for (let i = start; i < Math.min(start + count, state.items.length); i++) {
              const skill = state.items[i]!,
                selected = i === selectedIndex;
              add(
                `${selected ? S_RADIO_ACTIVE : S_RADIO_INACTIVE} ${skill.slug}@${skill.currentVersion} · ${installs(skill.installCount)}`,
              );
            }
          }
          add('↑/↓ — выбор · Enter — установить · Введите префикс slug · Esc / Ctrl+C — отмена');
          add(S_BAR_END);
        }
        clear();
        previousLines = body.map((line) => (line === S_BAR_END ? line : `${S_BAR} ${line}`));
        if (previousLines.length)
          streams.output.write(
            previousLines
              .map((line, i) =>
                styleText(
                  i === 0 || body[i]!.startsWith('Префикс slug:')
                    ? 'cyan'
                    : body[i]!.startsWith(S_RADIO_ACTIVE)
                      ? 'green'
                      : body[i]!.startsWith('Не удалось выполнить поиск:')
                        ? 'red'
                        : 'gray',
                  line,
                ),
              )
              .join('\n') + '\n',
          );
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
    emitKeypressEvents(streams.input);
    streams.input.on('keypress', onKey);
    streams.input.on('end', onEnd);
    streams.output.on('resize', onResize);
    streams.input.setRawMode?.(true);
    streams.input.resume();
    streams.output.write('\u001b[?25l');
    search.setPrefix(initialPrefix, true);
  });
}
