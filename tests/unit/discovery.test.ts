import { describe, expect, it, vi } from 'vitest';
import { RegistryClient } from '@/registry/client';

import { catalogItem, skillDetail } from '../helpers/discovery.ts';

describe('registry discovery', () => {
  it.each(['api-', 'API-', 'api%', 'api_', "api' OR 1=1 --", 'слуг&?'])(
    'sends literal prefix %s to the backend without normalizing it',
    async (prefix) => {
      const http = vi.fn<typeof fetch>(async () => Response.json({ items: [catalogItem()] }));
      const client = new RegistryClient('https://registry.example.test/origin', http);
      expect((await client.listSkills(prefix)).map((s) => s.slug)).toEqual(['demo']);
      const url = new URL(String(http.mock.calls[0]![0]));
      expect(url.pathname).toBe('/origin/api/v1/skills');
      expect(url.searchParams.get('slugPrefix')).toBe(prefix);
      expect([...url.searchParams.keys()]).toEqual(['slugPrefix']);
    },
  );

  it.each([
    {},
    [],
    { items: {} },
    { items: [null] },
    { items: [catalogItem({ tags: [5] })] },
    { items: [catalogItem({ slug: '../../demo' })] },
    { items: [catalogItem({ currentVersion: 'latest' })] },
    { items: [catalogItem({ installCount: -1 })] },
    { items: [catalogItem({ installCount: '2' })] },
  ])('rejects malformed catalog %j', async (data) => {
    const client = new RegistryClient('https://registry.example.test', async () =>
      Response.json(data),
    );
    await expect(client.listSkills()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each(['list', 'details'] as const)(
    'distinguishes %s network/HTTP/JSON errors from an empty result',
    async (operation) => {
      for (const response of [
        new Response(null, { status: 503 }),
        new Response('invalid JSON'),
        new Response(null, { status: 404 }),
      ]) {
        const client = new RegistryClient('https://registry.example.test', async () => response);
        await expect(
          operation === 'list' ? client.listSkills() : client.getSkill('demo'),
        ).rejects.toThrow();
      }
      const client = new RegistryClient('https://registry.example.test', async () => {
        throw new Error('offline');
      });
      await expect(
        operation === 'list' ? client.listSkills() : client.getSkill('demo'),
      ).rejects.toMatchObject({ code: 'REGISTRY_UNAVAILABLE' });
    },
  );

  it.each([['1.2.3'], ['1.2.3', '1.0.0']])(
    'reads published versions %j without fetching files',
    async (...versions) => {
      const http = vi.fn<typeof fetch>(async () => Response.json(skillDetail({ versions })));
      const result = await new RegistryClient('https://registry.example.test', http).getSkill(
        'demo',
      );
      expect(result).toMatchObject({ slug: 'demo', currentVersion: '1.2.3', versions });
      expect(http).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { slug: 'other' },
    { versions: ['latest'] },
    { versions: [] },
    { longDescription: null },
    { version: 'latest' },
  ])('rejects malformed card %j', async (overrides) => {
    await expect(
      new RegistryClient('https://registry.example.test', async () =>
        Response.json(skillDetail(overrides)),
      ).getSkill('demo'),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each(['../../demo', 'demo@1.2.3', ''])('rejects detail slug %s before HTTP', async (slug) => {
    const http = vi.fn<typeof fetch>();
    await expect(
      new RegistryClient('https://registry.example.test', http).getSkill(slug),
    ).rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
    expect(http).not.toHaveBeenCalled();
  });
});
