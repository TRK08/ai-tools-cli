import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegistryFindSearch } from '@/cli/find-search';
import { RegistryClient } from '@/registry/client';
import { catalogItem } from '../helpers/discovery.ts';

function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Response>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const reply = (slug: string) => Response.json({ items: [catalogItem({ slug })] });
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe('backend find request lifecycle', () => {
  it.each(['', 'a', '🚀'])(
    'keeps short prefix %j idle without HTTP, including immediate search and retry',
    async (prefix) => {
      vi.useFakeTimers();
      const http = vi.fn<typeof fetch>();
      const search = new RegistryFindSearch(
        new RegistryClient('https://registry.example.test', http),
        vi.fn(),
      );
      try {
        search.setPrefix(prefix);
        await vi.advanceTimersByTimeAsync(300);
        search.setPrefix(prefix, true);
        search.retry();
        expect(search.state).toEqual({ prefix, status: 'idle', items: [] });
        expect(http).not.toHaveBeenCalled();
      } finally {
        search.close();
      }
    },
  );

  it('starts searching with the second character and clears its pending debounce when shortened', async () => {
    vi.useFakeTimers();
    const http = vi.fn<typeof fetch>(async () => reply('demo'));
    const search = new RegistryFindSearch(
      new RegistryClient('https://registry.example.test', http),
      vi.fn(),
    );
    try {
      search.setPrefix('de');
      await vi.advanceTimersByTimeAsync(100);
      search.setPrefix('d');
      await vi.advanceTimersByTimeAsync(300);
      expect(http).not.toHaveBeenCalled();
      search.setPrefix('de');
      await vi.advanceTimersByTimeAsync(200);
      expect(http).toHaveBeenCalledTimes(1);
      expect(search.state.items).toHaveLength(1);
      search.setPrefix('d');
      expect(search.state).toEqual({ prefix: 'd', status: 'idle', items: [] });
    } finally {
      search.close();
    }
  });

  it('waits 200ms after the last edit and sends one request with the unchanged prefix', async () => {
    vi.useFakeTimers();
    const http = vi.fn<typeof fetch>(async () => reply('api-check'));
    const changed = vi.fn();
    const search = new RegistryFindSearch(
      new RegistryClient('https://registry.example.test', http),
      changed,
    );
    try {
      search.setPrefix('A');
      await vi.advanceTimersByTimeAsync(100);
      search.setPrefix('API-');
      await vi.advanceTimersByTimeAsync(199);
      expect(http).not.toHaveBeenCalled();
      expect(search.state).toMatchObject({ status: 'loading', prefix: 'API-', items: [] });
      await vi.advanceTimersByTimeAsync(1);
      expect(http).toHaveBeenCalledTimes(1);
      expect(String(http.mock.calls[0]![0])).toBe(
        'https://registry.example.test/api/v1/skills?slugPrefix=API-',
      );
      expect(search.state).toMatchObject({
        status: 'ready',
        items: [expect.objectContaining({ slug: 'api-check' })],
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
        search.setPrefix('ap', true);
        search.setPrefix('api-', true);
        expect(http.mock.calls[0]![1]!.signal!.aborted).toBe(true);
        expect(search.state.items).toEqual([]);
        second.resolve(reply('api-check'));
        await settle();
        const current = search.state;
        if (outcome === 'success') first.resolve(reply('another'));
        else first.reject(new Error('obsolete failure'));
        await settle();
        expect(search.state).toBe(current);
        expect(search.state.items[0]!.slug).toBe('api-check');
      } finally {
        search.close();
      }
    },
  );

  it('clears selectable results immediately on edit and fetches again for a previously used prefix', async () => {
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
      search.setPrefix('dem', true);
      await settle();
      expect(search.state.items).toHaveLength(1);
      search.setPrefix('demo-', true);
      expect(search.state.items).toEqual([]);
      search.setPrefix('d');
      expect(search.state).toEqual({ prefix: 'd', status: 'idle', items: [] });
      expect(http.mock.calls[1]![1]!.signal!.aborted).toBe(true);
      pending.resolve(reply('obsolete'));
      await settle();
      expect(search.state.status).toBe('idle');
      search.setPrefix('dem', true);
      await settle();
      expect(search.state.items[0]!.slug).toBe('demo-new');
      expect(http).toHaveBeenCalledTimes(3);
    } finally {
      search.close();
    }
  });

  it('shows a network error separately from empty results and allows retry', async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ items: [] }));
    const search = new RegistryFindSearch(
      new RegistryClient('https://registry.example.test', http),
      vi.fn(),
    );
    try {
      search.setPrefix('demo', true);
      await settle();
      expect(search.state).toMatchObject({
        status: 'error',
        message: expect.stringContaining('HTTP 503'),
        items: [],
      });
      search.retry();
      await settle();
      expect(search.state).toMatchObject({ status: 'ready', items: [] });
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
    search.setPrefix('demo');
    search.close();
    await vi.advanceTimersByTimeAsync(300);
    expect(http).not.toHaveBeenCalled();
    const next = new RegistryFindSearch(
      new RegistryClient('https://registry.example.test', http),
      changed,
    );
    next.setPrefix('demo', true);
    next.close();
    const calls = changed.mock.calls.length;
    pending.resolve(reply('demo'));
    await settle();
    expect(changed).toHaveBeenCalledTimes(calls);
    expect(http.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
});
