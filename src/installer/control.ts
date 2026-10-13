import type { InstallationChange, SkippedUpdate, SkippedAdd } from './types.ts';

export class NoConnections extends Error {
  /** Переносит failed-результат через откат FileTransaction, если ни одно подключение не удалось. */
  constructor(readonly result: InstallationChange) {
    super('Не удалось создать ни одного запрошенного подключения.');
  }
}

export class UpdateSkipped extends Error {
  /** Прерывает текущую установку update с решением об отказе или отмене для пакетного фасада. */
  constructor(readonly result: SkippedUpdate) {
    super('Обновление не подтверждено.');
  }
}

export class AddSkipped extends Error {
  /** Прерывает add до изменения установки, сохраняя skipped-результат для возврата после очистки. */
  constructor(readonly result: SkippedAdd) {
    super('Установка не подтверждена.');
  }
}
