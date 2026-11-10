import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegistryFindSearch } from '@/cli/find-search';
import { RegistryClient } from '@/registry/client';
import { registrySkill } from '../helpers/registry.ts';

function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Response>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const reply = (slug: string) =>
  Response.json({
    items: [registrySkill('demo', slug, '1.0.0').wire],
    total: 1,
    limit: 10,
    offset: 0,
  });
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe('backend find request lifecycle', () => {
  it.each(['', ' ', '\t', 'd', 'de', ' de '])(
    'keeps short query %j idle without HTTP, including immediate search and retry',
    async (query) => {
      vi.useFakeTimers();
      const http = vi.fn<typeof fetch>();
      const search = new RegistryFindSearch(
        new RegistryClient('https://registry.example.test', http),
        vi.fn(),
      );
      try {
        search.setQuery(query);
        await vi.advanceTimersByTimeAsync(300);
        search.setQuery(query, true);
        search.retry();
        expect(search.state).toEqual({ query, status: 'idle', items: [], total: 0 });
        expect(http).not.toHaveBeenCalled();
      } finally {
        search.close();
      }
    },
  );

  it('starts searching with three characters and clears the pending debounce for an empty query', async () => {
    vi.useFakeTimers();
    const http = vi.fn<typeof fetch>(async () => reply('demo'));
    const search = new RegistryFindSearch(
      new RegistryClient('https://registry.example.test', http),
      vi.fn(),
    );
    try {
      search.setQuery('dem');
      await vi.advanceTimersByTimeAsync(100);
      search.setQuery('');
      await vi.advanceTimersByTimeAsync(300);
      expect(http).not.toHaveBeenCalled();
      search.setQuery('dem');
      await vi.advanceTimersByTimeAsync(200);
      expect(http).toHaveBeenCalledTimes(1);
      expect(search.state.items).toHaveLength(1);
      search.setQuery('');
      expect(search.state).toEqual({ query: '', status: 'idle', items: [], total: 0 });
    } finally {
      search.close();
    }
  });

  it('waits 200ms after the last edit and sends one request with the unchanged query', async () => {
    vi.useFakeTimers();
    const http = vi.fn<typeof fetch>(async () => reply('api-check'));
    const changed = vi.fn();
    const search = new RegistryFindSearch(
      new RegistryClient('https://registry.example.test', http),
      changed,
    );
    try {
      search.setQuery('A');
      await vi.advanceTimersByTimeAsync(100);
      search.setQuery('API-');
      await vi.advanceTimersByTimeAsync(199);
      expect(http).not.toHaveBeenCalled();
      expect(search.state).toMatchObject({ status: 'loading', query: 'API-', items: [], total: 0 });
      await vi.advanceTimersByTimeAsync(1);
      expect(http).toHaveBeenCalledTimes(1);
      expect(String(http.mock.calls[0]![0])).toBe(
        'https://registry.example.test/api/v1/components?kind=skill&q=API-&sort=popular&limit=10',
      );
      expect(search.state).toMatchObject({
        status: 'ready',
        items: [expect.objectContaining({ name: 'api-check' })],
      });
    } finally {
      search.close();
    }
  });

  it.each(['success', 'error'] as const)(
    'aborts the older request and ignores its late %s',
    async (outcome) => {
      const first = deferred(),
        second = deferred();
      const http = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise);
      const search = new RegistryFindSearch(
        new RegistryClient('https://registry.example.test', http),
        vi.fn(),
      );
      try {
        search.setQuery('api', true);
        search.setQuery('api-', true);
        expect(http.mock.calls[0]![1]!.signal!.aborted).toBe(true);
        expect(search.state.items).toEqual([]);
        second.resolve(reply('api-check'));
        await settle();
        const current = search.state;
        if (outcome === 'success') first.resolve(reply('another'));
        else first.reject(new Error('obsolete failure'));
        await settle();
        expect(search.state).toBe(current);
        expect(search.state.items[0]!.name).toBe('api-check');
      } finally {
        search.close();
      }
    },
  );

  it('clears selectable results immediately on edit and fetches again for a previously used query', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply('demo'))
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(reply('demo-new'));
    const search = new RegistryFindSearch(
      new RegistryClient('https://registry.example.test', http),
      vi.fn(),
    );
    try {
      search.setQuery('dem', true);
      await settle();
      expect(search.state.items).toHaveLength(1);
      search.setQuery('demo-', true);
      expect(search.state.items).toEqual([]);
      search.setQuery('');
      expect(search.state).toEqual({ query: '', status: 'idle', items: [], total: 0 });
      expect(http.mock.calls[1]![1]!.signal!.aborted).toBe(true);
      pending.resolve(reply('obsolete'));
      await settle();
      expect(search.state.status).toBe('idle');
      search.setQuery('dem', true);
      await settle();
      expect(search.state.items[0]!.name).toBe('demo-new');
      expect(http).toHaveBeenCalledTimes(3);
    } finally {
      search.close();
    }
  });

  it('shows a network error separately from empty results and allows retry', async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ items: [], total: 0, limit: 10, offset: 0 }));
    const search = new RegistryFindSearch(
      new RegistryClient('https://registry.example.test', http),
      vi.fn(),
    );
    try {
      search.setQuery('demo', true);
      await settle();
      expect(search.state).toMatchObject({
        status: 'error',
        message: expect.stringContaining('HTTP 503'),
        items: [],
      });
      search.retry();
      await settle();
      expect(search.state).toMatchObject({ status: 'ready', items: [], total: 0 });
      expect(http).toHaveBeenCalledTimes(2);
    } finally {
      search.close();
    }
  });

  it('closing clears debounce timers and ignores responses from a noncooperative transport', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const http = vi.fn<typeof fetch>(() => pending.promise);
    const changed = vi.fn();
    const search = new RegistryFindSearch(
      new RegistryClient('https://registry.example.test', http),
      changed,
    );
    search.setQuery('demo');
    search.close();
    await vi.advanceTimersByTimeAsync(300);
    expect(http).not.toHaveBeenCalled();
    const next = new RegistryFindSearch(
      new RegistryClient('https://registry.example.test', http),
      changed,
    );
    next.setQuery('demo', true);
    next.close();
    const calls = changed.mock.calls.length;
    pending.resolve(reply('demo'));
    await settle();
    expect(changed).toHaveBeenCalledTimes(calls);
    expect(http.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
});
