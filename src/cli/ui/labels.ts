import type { InstallationScope } from '@/runtime';

/** Возвращает русскую подпись области для сообщений CLI. */
export const scopeLabel = (scope: InstallationScope): string =>
  scope === 'project' ? 'текущий проект' : 'глобальная область';

/** Различает ошибку и частичный результат в сообщениях CLI. */
export const failureLabel = (status: 'partial' | 'failed'): string =>
  status === 'partial' ? 'Частичный результат' : 'Ошибка';

/** Выбирает русскую форму существительного для целого счётчика с учётом окончания 11–14. */
export function plural(count: number, one: string, few: string, many: string): string {
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  const last = count % 10;
  return last === 1 ? one : last >= 2 && last <= 4 ? few : many;
}
