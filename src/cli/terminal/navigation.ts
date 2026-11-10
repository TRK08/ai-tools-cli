import type { Key } from 'node:readline';

const aliases: Readonly<Record<string, string>> = { k: 'up', j: 'down', h: 'left', l: 'right' };

/** Сохраняет vim-клавиши прежних Clack-диалогов; в поиске буквы остаются частью запроса. */
export function navigationKey(key: Key, vim = false): string | undefined {
  return vim ? (aliases[key.name ?? ''] ?? key.name) : key.name;
}

/** Смещает курсор по существующим вариантам; циклический режим нужен одиночному выбору. */
export function moveSelection(index: number, delta: number, length: number, wrap = false): number {
  if (!length) return 0;
  return wrap
    ? (index + delta + length) % length
    : Math.max(0, Math.min(index + delta, length - 1));
}

/** Возвращает начало видимого участка, удерживая выбранный пункт внутри окна. */
export function visibleStart(index: number, count: number, length: number): number {
  return Math.max(0, Math.min(index - Math.floor(count / 2), length - count));
}
