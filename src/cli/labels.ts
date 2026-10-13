import type { InstallationScope } from '../installer/types.ts';
import type { InstallationRecord } from '../state/types.ts';

export const scopeLabel = (scope: InstallationScope): string =>
  scope === 'project' ? 'текущий проект' : 'глобальная область';

export const policyLabel = (policy: InstallationRecord['policy']): string =>
  ({ latest: 'Актуальная (latest)', exact: 'Закреплённая (exact)', local: 'Локальная' })[policy];

export const failureLabel = (status: 'partial' | 'failed'): string =>
  status === 'partial' ? 'Частичный результат' : 'Ошибка';

export function plural(count: number, one: string, few: string, many: string): string {
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  const last = count % 10;
  return last === 1 ? one : last >= 2 && last <= 4 ? few : many;
}
