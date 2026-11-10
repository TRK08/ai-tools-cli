import { type RegistryClient, type CatalogPage, type CatalogSkill } from '@/registry';

/** Проверяет минимум три Unicode-символа после trim без изменения запроса. */
export function canSearchQuery(query: string): boolean {
  return [...query.trim()].length >= 3;
}

export type FindSearchState = {
  readonly query: string;
  readonly items: readonly CatalogSkill[];
  readonly total: number;
} & (
  | { readonly status: 'idle' | 'loading' | 'ready' }
  | { readonly status: 'error'; readonly message: string }
);

/** Управляет запросами UI; поисковый запрос интерпретирует core. */
export class RegistryFindSearch {
  state: FindSearchState = { query: '', items: [], total: 0, status: 'idle' };
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
   * Очищает результаты, отменяет предыдущий запрос и планирует поиск для запроса от трёх символов.
   *
   * @param immediate - Запустить HTTP сразу, пропустив debounce.
   */
  setQuery(query: string, immediate = false): void {
    if (this.closed) return;
    const revision = ++this.revision;
    clearTimeout(this.timer);
    this.controller?.abort();
    const searchable = canSearchQuery(query);
    this.state = { query, items: [], total: 0, status: searchable ? 'loading' : 'idle' };
    this.changed();
    if (!searchable || this.closed) return;
    const controller = new AbortController();
    this.controller = controller;
    if (immediate) void this.request(query, controller, revision);
    else
      this.timer = setTimeout(() => {
        void this.request(query, controller, revision);
      }, this.delayMs);
  }

  /**
   * Получает до 10 популярных результатов, сохраняя серверный порядок; публикует только ответ текущей ревизии.
   * Ошибка становится отдельным состоянием error, а не пустым результатом.
   */
  private async request(
    query: string,
    controller: AbortController,
    revision: number,
  ): Promise<void> {
    let page: CatalogPage;
    try {
      page = await this.client.listSkills(query.trim(), controller.signal);
    } catch (cause) {
      if (this.closed || revision !== this.revision) return;
      this.state = {
        query,
        items: [],
        total: 0,
        status: 'error',
        message: cause instanceof Error ? cause.message : 'Не удалось выполнить запрос к реестру.',
      };
      this.changed();
      return;
    }
    if (this.closed || revision !== this.revision) return;
    this.state = { query, items: page.items, total: page.total, status: 'ready' };
    this.changed();
  }

  /** Повторяет поиск текущего запроса сразу, без задержки debounce. */
  retry(): void {
    this.setQuery(this.state.query, true);
  }

  /** Отменяет таймер и HTTP, запрещает новые запросы и публикацию запоздалых ответов. */
  close(): void {
    this.closed = true;
    this.revision++;
    clearTimeout(this.timer);
    this.controller?.abort();
  }
}
