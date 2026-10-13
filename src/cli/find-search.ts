import type { RegistryClient } from '../registry/client.ts';
import { sortCatalog, type CatalogSkill } from '../registry/catalog.ts';

export const MIN_FIND_PREFIX_LENGTH = 2;

/** Проверяет минимальную длину префикса в кодовых точках Unicode без его изменения. */
export function canSearchPrefix(prefix: string): boolean {
  return [...prefix].length >= MIN_FIND_PREFIX_LENGTH;
}

export type FindSearchState = {
  readonly prefix: string;
  readonly items: readonly CatalogSkill[];
} & (
  | { readonly status: 'idle' | 'loading' | 'ready' }
  | { readonly status: 'error'; readonly message: string }
);

/** Управляет запросами UI; буквальный префикс с учётом регистра интерпретирует только backend. */
export class RegistryFindSearch {
  state: FindSearchState = { prefix: '', items: [], status: 'idle' };
  private revision = 0;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;

  /** Связывает registry-клиент, уведомление renderer и задержку debounce; сам запрос не запускает. */
  constructor(
    private readonly client: RegistryClient,
    private readonly changed: () => void,
    private readonly delayMs = 200,
  ) {}

  /**
   * Очищает результаты, отменяет предыдущий запрос и планирует поиск для достаточного префикса.
   *
   * @param immediate - Запустить HTTP сразу, пропустив debounce.
   */
  setPrefix(prefix: string, immediate = false): void {
    if (this.closed) return;
    const revision = ++this.revision;
    clearTimeout(this.timer);
    this.controller?.abort();
    const searchable = canSearchPrefix(prefix);
    this.state = { prefix, items: [], status: searchable ? 'loading' : 'idle' };
    this.changed();
    if (!searchable || this.closed) return;
    const controller = new AbortController();
    this.controller = controller;
    if (immediate) void this.request(prefix, controller, revision);
    else
      this.timer = setTimeout(() => {
        void this.request(prefix, controller, revision);
      }, this.delayMs);
  }

  /**
   * Получает и сортирует серверные результаты; публикует только ответ текущей ревизии. Ошибка становится
   * отдельным состоянием error, а не пустым результатом.
   */
  private async request(
    prefix: string,
    controller: AbortController,
    revision: number,
  ): Promise<void> {
    let items: readonly CatalogSkill[];
    try {
      items = await this.client.listSkills(prefix, controller.signal);
    } catch (cause) {
      if (this.closed || revision !== this.revision) return;
      this.state = {
        prefix,
        items: [],
        status: 'error',
        message: cause instanceof Error ? cause.message : 'Не удалось выполнить запрос к реестру.',
      };
      this.changed();
      return;
    }
    if (this.closed || revision !== this.revision) return;
    this.state = { prefix, items: sortCatalog(items), status: 'ready' };
    this.changed();
  }

  /** Повторяет поиск текущего префикса сразу, без задержки debounce. */
  retry(): void {
    this.setPrefix(this.state.prefix, true);
  }

  /** Отменяет таймер и HTTP, запрещает новые запросы и публикацию запоздалых ответов. */
  close(): void {
    this.closed = true;
    this.revision++;
    clearTimeout(this.timer);
    this.controller?.abort();
  }
}
