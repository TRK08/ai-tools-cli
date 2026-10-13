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
import { wrapTerminalText } from './table.ts';
import { plural } from './labels.ts';

// Adapted from ../skills/src/find.ts; see ThirdPartyNoticeText.txt.
function installs(count: number): string {
  const value =
    count >= 1_000_000
      ? `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '').replace('.', ',')} млн`
      : count >= 1_000
        ? `${(count / 1_000).toFixed(1).replace(/\.0$/, '').replace('.', ',')} тыс.`
        : String(count);
  return `${value} ${count >= 1_000 ? 'установок' : plural(count, 'установка', 'установки', 'установок')}`;
}

/** Clack-styled async picker: native autocomplete supports synchronous options only. */
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
    const previousRaw = streams.input.isRaw ?? false;
    const search = new RegistryFindSearch(client, () => {
      selectedIndex = 0;
      render();
    });

    const clear = () => {
      if (previousLines.length) streams.output.write(`\u001b[${previousLines.length}A\r\u001b[J`);
      previousLines = [];
    };
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

    function render() {
      if (closed) return;
      try {
        const width = Math.max(16, (streams.output.columns ?? 80) - 4);
        const body: string[] = [];
        const add = (text: string) => {
          body.push(...wrapTerminalText(text, width));
        };
        add(`${S_STEP_ACTIVE} Найдите скилл для установки · префикс slug`);
        const prefix =
          terminalText(query.slice(0, cursor).join('')) +
          '█' +
          terminalText(query.slice(cursor).join(''));
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
          const count = Math.min(8, Math.max(1, (streams.output.rows ?? 24) - 10));
          const start = Math.max(
            0,
            Math.min(selectedIndex - Math.floor(count / 2), state.items.length - count),
          );
          add(`Совпадений: ${state.items.length}`);
          if (start > 0) add('…');
          for (let i = start; i < Math.min(start + count, state.items.length); i++) {
            const skill = state.items[i]!,
              selected = i === selectedIndex;
            add(
              `${selected ? S_RADIO_ACTIVE : S_RADIO_INACTIVE} ${skill.slug}@${skill.currentVersion} · ${installs(skill.installCount)}`,
            );
          }
          if (start + count < state.items.length) add('…');
        }
        const maximum = Math.max(5, (streams.output.rows ?? 24) - 5);
        if (body.length > maximum) {
          body.splice(maximum - 1);
          body.push('…');
        }
        add('↑/↓ — выбор · Enter — установить · Введите префикс slug · Esc / Ctrl+C — отмена');
        add(S_BAR_END);
        clear();
        previousLines = body.map((line) => (line === S_BAR_END ? line : `${S_BAR} ${line}`));
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

    function onKey(character: string | undefined, key: Key) {
      if (closed) return;
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        finish(null);
        return;
      }
      if (key.name === 'return') {
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
    function onEnd() {
      finish(null);
    }
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
