import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RegistryClient } from '../src/registry/client.ts';
import { getRegistryUrl, parseRegistryReference } from '../src/registry/reference.ts';
import { registryReferenceForSource } from '../src/sources/local.ts';
import { prepareRegistrySource } from '../src/sources/registry.ts';
import { artifact, json, registryBytes, withRegistryServer } from './helpers/registry.ts';
import { withTestEnvironment } from './helpers/test-environment.ts';

describe('registry reference and configuration', () => {
  it.each(['1.2.3', '0.0.0', '1.2.3-rc.1', '1.2.3-0+build.001', '1.2.3-alpha-beta.123+abc'])(
    'accepts full SemVer %s',
    (version) => {
      expect(parseRegistryReference(`demo@${version}`)).toEqual({ slug: 'demo', version });
    },
  );
  it.each(['', 'v1.2.3', '01.2.3', '1.02.3', '1.2', '^1.2.3', '1.2.3-01', '1.2.3+', '1.2.3\n'])(
    'rejects version %j',
    (version) => {
      expect(() => parseRegistryReference(`demo@${version}`)).toThrow(/полной версией SemVer/);
    },
  );
  it.each([
    './demo',
    '../demo',
    '/demo',
    'demo.tgz',
    'demo.tar.gz',
    'https://a.test/demo',
    'C:\\demo',
    'Demo',
    'bad--slug',
    'demo@1.2.3@extra',
    'demo\n',
  ])('does not parse %j as registry', (input) => {
    expect(parseRegistryReference(input)).toBeNull();
  });
  it('keeps existing bare folders local, missing archive paths local and bare slugs registry', async () => {
    await withTestEnvironment(async (f) => {
      await mkdir(join(f.roots.cwd, 'demo'));
      expect(await registryReferenceForSource('demo', f.roots.cwd)).toBeNull();
      expect(await registryReferenceForSource('demo.tgz', f.roots.cwd)).toBeNull();
      expect(await registryReferenceForSource('./missing', f.roots.cwd)).toBeNull();
      expect(await registryReferenceForSource('missing', f.roots.cwd)).toEqual({ slug: 'missing' });
    });
  });
  it('uses explicit URL, environment, default and normalizes the permanent base', () => {
    expect(
      getRegistryUrl(' HTTP://REGISTRY.test/base/// ', { SKILLS_API_URL: 'https://env.test' }),
    ).toBe('http://registry.test/base');
    expect(getRegistryUrl(undefined, { SKILLS_API_URL: 'https://env.test/' })).toBe(
      'https://env.test',
    );
    expect(getRegistryUrl(undefined, {})).toBe('http://localhost:8000');
  });
  it.each([
    'file:///tmp/demo',
    'bad',
    'https://user:secret@registry.test',
    'https://registry.test?token=secret',
    'https://registry.test#fragment',
  ])('rejects base %s', (base) => {
    expect(() => getRegistryUrl(base, {})).toThrow(/базовым HTTP\(S\) URL/);
  });
});

describe('registry HTTP client', () => {
  it('preserves a custom registry path prefix and URL-encodes an exact version', async () => {
    await withRegistryServer(
      async ({ url, requests }) => {
        await new RegistryClient(`${url}/base/`, fetch).resolveArtifact({
          slug: 'demo',
          version: '1.2.3+build.1',
        });
        expect(requests).toEqual(['/base/api/v1/skills/demo/artifact?version=1.2.3%2Bbuild.1']);
      },
      (_req, res, url) => json(res, artifact(`${url}/download`, { version: '1.2.3+build.1' })),
    );
  });

  it('accepts verified bytes at the exact 20 MiB input limit', async () => {
    const bytes = Buffer.alloc(20 * 1024 * 1024);
    const { createHash } = await import('node:crypto');
    await withRegistryServer(
      async ({ url }) => {
        const selected = artifact(`${url}/download`, {
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
        const result = await new RegistryClient(url, fetch).downloadArtifact(selected);
        expect(result.bytes.equals(bytes)).toBe(true);
        expect(result.download.size).toBe(bytes.length);
      },
      (_req, res) => res.end(bytes),
    );
  });
  it('separates latest/exact metadata from verified bytes and sends no credentials or telemetry', async () => {
    await withRegistryServer(async ({ url, requests }) => {
      const transport = vi.fn(fetch);
      const client = new RegistryClient(url, transport);
      const latest = await client.resolveArtifact({ slug: 'demo' });
      expect(requests).toEqual(['/api/v1/skills/demo/artifact']);
      const exact = await client.resolveArtifact({ slug: 'demo', version: '1.2.3-rc.1+build.2' });
      expect(exact.version).toBe('1.2.3-rc.1+build.2');
      expect(requests[1]).toContain('version=1.2.3-rc.1%2Bbuild.2');
      const result = await client.downloadArtifact(latest);
      expect(result.bytes).toEqual(registryBytes);
      expect(result.download).toEqual({
        registryUrl: url,
        slug: 'demo',
        version: '1.2.3',
        archiveHash: latest.sha256,
        size: registryBytes.length,
      });
      expect(JSON.stringify(result.download)).not.toMatch(/signature|expires|secret/);
      for (const [, options] of transport.mock.calls) {
        expect(options).toMatchObject({ credentials: 'omit', redirect: 'error' });
        expect(options?.headers).toBeUndefined();
      }
      expect(requests).toHaveLength(3);
    });
  });

  it.each([404, 503, 500, 400])('handles real backend error shape HTTP %i', async (status) => {
    await withRegistryServer(
      async ({ url }) => {
        for (const version of [undefined, '1.2.3']) {
          await expect(
            new RegistryClient(url, fetch).resolveArtifact({
              slug: 'demo',
              ...(version ? { version } : {}),
            }),
          ).rejects.toMatchObject({
            code: status === 404 ? 'NOT_FOUND' : 'REGISTRY_UNAVAILABLE',
            status,
            message: expect.stringContaining(`HTTP ${status}`),
          });
        }
      },
      (_req, res) =>
        json(
          res,
          {
            code: status === 404 ? 'not_found' : 'service_unavailable',
            message:
              status === 404 ? 'Skill or version not found' : 'Service temporarily unavailable',
            debugMessage: null,
          },
          status,
        ),
    );
  });

  it.each([
    ['slug', 'other'],
    ['version', 'v1.2.3'],
    ['version', '2.0.0'],
    ['version', 123],
    ['sha256', 'bad'],
    ['sha256', 'A'.repeat(64)],
    ['sha256', 123],
    ['sha256', `${'a'.repeat(64)}\n`],
    ['size', 0],
    ['size', 1.5],
    ['size', 20 * 1024 * 1024 + 1],
    ['size', '123'],
    ['format', 'zip'],
    ['url', '/relative'],
    ['url', 'file:///tmp/archive'],
    ['url', 'https://user:password@example.test/file'],
    ['url', null],
    ['url', 'https://example.test/file\n'],
    ['expiresAt', 'tomorrow'],
    ['expiresAt', '2026-10-13'],
    ['expiresAt', null],
    ['expiresAt', '2099-01-01T00:00:00Z\n'],
  ])('rejects invalid artifact %s=%j', async (key, value) => {
    await withRegistryServer(
      async ({ url }) => {
        await expect(
          new RegistryClient(url, fetch).resolveArtifact({ slug: 'demo', version: '1.2.3' }),
        ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
      },
      (_req, res, url) => json(res, { ...artifact(`${url}/download`), [key]: value }),
    );
  });

  it.each(['invalid-json', 'null', 'array', 'huge', 'empty'])(
    'rejects %s metadata',
    async (failure) => {
      await withRegistryServer(
        async ({ url }) => {
          await expect(
            new RegistryClient(url, fetch).resolveArtifact({ slug: 'demo' }),
          ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
        },
        (_req, res) => {
          res.end(
            failure === 'invalid-json'
              ? '{'
              : failure === 'null'
                ? 'null'
                : failure === 'array'
                  ? '[]'
                  : failure === 'huge'
                    ? ' '.repeat(65537)
                    : '',
          );
        },
      );
    },
  );

  it.each(['metadata', 'download'] as const)(
    'times out stalled %s headers and body',
    async (stage) => {
      for (const headers of [false, true]) {
        await withRegistryServer(
          async ({ url }) => {
            const client = new RegistryClient(url, fetch, { timeoutMs: 40 });
            const run =
              stage === 'metadata'
                ? client.resolveArtifact({ slug: 'demo' })
                : client.downloadArtifact(artifact(`${url}/download`));
            await expect(run).rejects.toMatchObject({
              code: stage === 'metadata' ? 'REGISTRY_UNAVAILABLE' : 'DOWNLOAD_FAILED',
              message: expect.stringContaining('превысил'),
            });
          },
          (_req, res) => {
            if (headers) {
              res.writeHead(200);
              res.write('a');
            }
          },
        );
      }
    },
  );

  it.each(['size', 'hash', 'limit', 'truncated'])(
    'rejects %s download before preparation',
    async (failure) => {
      await withRegistryServer(
        async ({ url }) => {
          const selected = artifact(
            `${url}/download`,
            failure === 'size'
              ? { size: registryBytes.length + 1 }
              : failure === 'hash'
                ? { sha256: 'a'.repeat(64) }
                : {},
          );
          await expect(
            new RegistryClient(url, fetch).downloadArtifact(selected),
          ).rejects.toMatchObject({
            code:
              failure === 'limit'
                ? 'INVALID_RESPONSE'
                : failure === 'truncated'
                  ? 'DOWNLOAD_FAILED'
                  : 'ARTIFACT_MISMATCH',
          });
        },
        (_req, res) => {
          if (failure === 'limit') res.end(Buffer.alloc(20 * 1024 * 1024 + 1));
          else if (failure === 'truncated') {
            res.writeHead(200, { 'Content-Length': registryBytes.length + 100 });
            res.write(registryBytes);
            res.destroy();
          } else res.end(registryBytes);
        },
      );
    },
  );

  it.each(['expired', '401', '403'])(
    'refreshes %s once for the resolved version instead of latest',
    async (failure) => {
      await withRegistryServer(
        async ({ url, requests }) => {
          const client = new RegistryClient(url, fetch);
          const original = await client.resolveArtifact({ slug: 'demo' });
          expect((await client.downloadArtifact(original)).bytes).toEqual(registryBytes);
          expect(requests.filter((p) => p.startsWith('/api/'))).toEqual([
            '/api/v1/skills/demo/artifact',
            '/api/v1/skills/demo/artifact?version=1.2.3',
          ]);
          expect(requests.filter((p) => p.startsWith('/old')).length).toBe(
            failure === 'expired' ? 0 : 1,
          );
        },
        (req, res, url) => {
          if (req.url!.startsWith('/api/')) {
            const exact = req.url!.includes('version=');
            json(
              res,
              artifact(`${url}/${exact ? 'fresh' : 'old'}?signature=secret`, {
                expiresAt:
                  failure === 'expired' && !exact ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z',
              }),
            );
          } else if (req.url!.startsWith('/old')) res.writeHead(Number(failure)).end();
          else res.end(registryBytes);
        },
      );
    },
  );

  it.each(['hash', 'size', 'version', 'slug', 'expired', 'repeated-403'])(
    'rejects refresh %s without another retry',
    async (failure) => {
      await withRegistryServer(
        async ({ url, requests }) => {
          const client = new RegistryClient(url, fetch);
          const original = artifact(`${url}/old`);
          await expect(client.downloadArtifact(original)).rejects.toBeInstanceOf(Error);
          expect(requests.filter((p) => p.startsWith('/api/'))).toHaveLength(1);
          expect(requests.length).toBe(failure === 'repeated-403' ? 3 : 2);
        },
        (req, res, url) => {
          if (req.url!.startsWith('/api/'))
            json(
              res,
              artifact(
                `${url}/fresh`,
                failure === 'hash'
                  ? { sha256: 'a'.repeat(64) }
                  : failure === 'size'
                    ? { size: registryBytes.length + 1 }
                    : failure === 'version'
                      ? { version: '2.0.0' }
                      : failure === 'slug'
                        ? { slug: 'other' }
                        : failure === 'expired'
                          ? { expiresAt: '2000-01-01T00:00:00Z' }
                          : {},
              ),
            );
          else res.writeHead(403).end();
        },
      );
    },
  );

  it('does not leak signed URLs in a transport error', async () => {
    const transport = vi
      .fn()
      .mockRejectedValue(new Error('failed https://download.test?signature=secret'));
    await expect(
      new RegistryClient('http://registry.test', transport).downloadArtifact(
        artifact('https://download.test?signature=secret'),
      ),
    ).rejects.toMatchObject({
      message: 'Скачивание артефакта завершилось ошибкой или превысило время ожидания.',
    });
  });

  it('cleans prepared downloads and exposes verified download details without a URL', async () => {
    await withRegistryServer(async ({ url }) =>
      withTestEnvironment(async (f) => {
        const onDownload = vi.fn();
        const prepared = await prepareRegistrySource(
          { slug: 'demo' },
          new RegistryClient(url, fetch),
          { cwd: f.roots.cwd, temporaryDirectory: f.env.TMPDIR! },
          onDownload,
        );
        expect(prepared.identity).toEqual({ kind: 'registry', registryUrl: url, slug: 'demo' });
        expect(prepared.version).toBe('1.2.3');
        expect(onDownload).toHaveBeenCalledWith(prepared.download);
        await prepared.cleanup();
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
      }),
    );
  });
});
