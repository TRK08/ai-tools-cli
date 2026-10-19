import { readdir } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { RegistryClient } from '../src/registry/client.ts';
import { runCli } from './helpers/cli.ts';
import { catalogItem, skillDetail } from './helpers/discovery.ts';
import { json, withRegistryServer } from './helpers/registry.ts';
import { withTestEnvironment } from './helpers/test-environment.ts';

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
    { items: [catalogItem({ slug: '../demo' })] },
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

  it.each(['../demo', 'demo@1.2.3', ''])('rejects detail slug %s before HTTP', async (slug) => {
    const http = vi.fn<typeof fetch>();
    await expect(
      new RegistryClient('https://registry.example.test', http).getSkill(slug),
    ).rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
    expect(http).not.toHaveBeenCalled();
  });

  it('runs find with explicit and environment registries and rejects removed info without HTTP', async () => {
    await withRegistryServer(
      async ({ url, requests }) =>
        withTestEnvironment(
          async (f) => {
            const before = await readdir(f.roots.cwd);
            const homeBefore = await readdir(f.roots.home);
            const found = await runCli(f, ['find', 'dem', '--registry', url]);
            expect(found).toMatchObject({ status: 0, stderr: '' });
            expect(found.stdout).toContain('demo');
            expect(found.stdout).toContain('1.2.3');
            expect(found.stdout).toContain('Установок');
            expect(found.stdout).toMatch(/\b2\b/);
            expect(found.stdout).not.toContain('Checks HTTP contracts');
            expect(found.stdout).not.toContain('API Contract Checker');
            expect(found.stdout).not.toContain('\u001b');
            const env = { ...f, env: { ...f.env, SKILLS_API_URL: url } };
            const fromEnv = await runCli(env, ['find', 'dem']);
            expect(fromEnv).toMatchObject({ status: 0, stderr: '' });
            expect(fromEnv.stdout).toContain('demo');
            expect((await runCli(env, ['find', 'no-match'])).stdout).toContain('Скиллы не найдены');
            const removed = await runCli(env, ['info', 'demo']);
            expect(removed.status).toBe(1);
            expect(removed.stdout).toBe('');
            expect(removed.stderr).toMatch(/Ошибка: .*info/);
            expect(await readdir(f.roots.cwd)).toEqual(before);
            expect(await readdir(f.roots.home)).toEqual(homeBefore);
            expect(requests).toEqual([
              '/api/v1/skills?slugPrefix=dem',
              '/api/v1/skills?slugPrefix=dem',
              '/api/v1/skills?slugPrefix=no-match',
            ]);
          },
          { env: { SKILLS_API_URL: 'http://127.0.0.1:1' } },
        ),
      (request, response) => {
        const parsed = new URL(request.url!, 'http://registry.example.test');
        if (parsed.pathname === '/api/v1/skills')
          return json(response, {
            items: 'demo'.startsWith(parsed.searchParams.get('slugPrefix') ?? '')
              ? [catalogItem({ shortDescription: 'Checks HTTP contracts\u001b[31m' })]
              : [],
          });
        json(response, { code: 'not_found', message: 'Not found' }, 404);
      },
    );
  });

  it('uses backend literal case-sensitive prefix fixtures through HTTP in the CLI', async () => {
    const items = ['api-contract-check', 'api-review', 'csv-audit', 'my-api-check'].map((slug) =>
      catalogItem({ slug }),
    );
    await withRegistryServer(
      async ({ url, requests }) =>
        withTestEnvironment(async (f) => {
          for (const [prefix, expected] of [
            ['api-', 2],
            ['API-', 0],
            ['api%', 0],
            ['api_', 0],
            ['contract', 0],
            ['csv', 1],
          ] as const) {
            const result = await runCli(f, ['find', prefix, '--registry', url]);
            expect(result.status).toBe(0);
            expect(result.stdout).toContain(
              expected ? `Найдено скиллов: ${expected}` : 'Скиллы не найдены',
            );
            expect(new URL(requests.at(-1)!, url).searchParams.get('slugPrefix')).toBe(prefix);
          }
          expect(await readdir(f.roots.cwd)).toEqual([]);
        }),
      (request, response, url) => {
        const prefix = new URL(request.url!, url).searchParams.get('slugPrefix') ?? '';
        json(response, { items: items.filter((item) => item.slug.startsWith(prefix)) });
      },
    );
  });

  it('prints an API error and code 1 without the empty-result message', async () => {
    await withRegistryServer(
      async ({ url }) =>
        withTestEnvironment(async (f) => {
          const result = await runCli(f, ['find', 'demo', '--registry', url]);
          expect(result.status).toBe(1);
          expect(result.stderr).toContain('HTTP 503');
          expect(result.stdout).not.toContain('Скиллы не найдены');
        }),
      (_request, response) =>
        json(response, { code: 'service_unavailable', message: 'Unavailable' }, 503),
    );
  });
});
