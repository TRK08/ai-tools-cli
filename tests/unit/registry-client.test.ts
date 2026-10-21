import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RegistryClient } from '../../src/registry/client.ts';
import { getRegistryUrl, parseRegistryReference } from '../../src/registry/reference.ts';
import { registryReferenceForSource } from '../../src/sources/local.ts';

import { artifact, registryBytes } from '../helpers/registry.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

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
    '../../demo',
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

const url = 'https://registry.test';
const selected = () => artifact(`${url}/download`);

describe('registry client with isolated HTTP transport', () => {
  it('preserves a custom registry path prefix and URL-encodes an exact version', async () => {
    const http = vi.fn<typeof fetch>(async () =>
      Response.json(artifact(`${url}/download`, { version: '1.2.3+build.1' })),
    );
    await new RegistryClient(`${url}/base/`, http).resolveArtifact({
      slug: 'demo',
      version: '1.2.3+build.1',
    });
    expect(String(http.mock.calls[0]![0])).toBe(
      `${url}/base/api/v1/skills/demo/artifact?version=1.2.3%2Bbuild.1`,
    );
  });
  it('accepts verified bytes at the exact 20 MiB input limit', async () => {
    const bytes = Buffer.alloc(20 * 1024 * 1024),
      { createHash } = await import('node:crypto');
    const http = vi.fn<typeof fetch>(async () => new Response(bytes));
    const result = await new RegistryClient(url, http).downloadArtifact(
      artifact(`${url}/download`, {
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }),
    );
    expect(result.bytes.equals(bytes)).toBe(true);
    expect(result.download.size).toBe(bytes.length);
  });
  it('separates latest/exact metadata from verified bytes and sends no credentials or telemetry', async () => {
    const http = vi.fn<typeof fetch>(async (input) => {
      const request = new URL(String(input));
      return request.pathname === '/download'
        ? new Response(new Uint8Array(registryBytes))
        : Response.json(
            artifact(`${url}/download?signature=secret`, {
              version: request.searchParams.get('version') ?? '1.2.3',
            }),
          );
    });
    const client = new RegistryClient(url, http),
      latest = await client.resolveArtifact({ slug: 'demo' });
    expect(
      (await client.resolveArtifact({ slug: 'demo', version: '1.2.3-rc.1+build.2' })).version,
    ).toBe('1.2.3-rc.1+build.2');
    // Signed query stays on the download request and never becomes permanent metadata.
    http.mockImplementationOnce(async () => new Response(new Uint8Array(registryBytes)));
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
    expect(http).toHaveBeenCalledTimes(3);
    for (const [, options] of http.mock.calls) {
      expect(options).toMatchObject({ credentials: 'omit', redirect: 'error' });
      expect(options?.headers).toBeUndefined();
    }
  });
  it.each([404, 503, 500, 400])('handles backend error shape HTTP %i', async (status) => {
    const http = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          code: status === 404 ? 'not_found' : 'service_unavailable',
          message: 'Backend error',
          debugMessage: null,
        },
        { status },
      ),
    );
    await expect(
      new RegistryClient(url, http).resolveArtifact({ slug: 'demo', version: '1.2.3' }),
    ).rejects.toMatchObject({
      code: status === 404 ? 'NOT_FOUND' : 'REGISTRY_UNAVAILABLE',
      status,
      message: expect.stringContaining(`HTTP ${status}`),
    });
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
    const http = async () => Response.json({ ...selected(), [key]: value });
    await expect(
      new RegistryClient(url, http).resolveArtifact({ slug: 'demo', version: '1.2.3' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it.each(['invalid-json', 'null', 'array', 'huge', 'empty'])(
    'rejects %s metadata',
    async (failure) => {
      const body =
        failure === 'invalid-json'
          ? '{'
          : failure === 'null'
            ? 'null'
            : failure === 'array'
              ? '[]'
              : failure === 'huge'
                ? ' '.repeat(65537)
                : '';
      await expect(
        new RegistryClient(url, async () => new Response(body)).resolveArtifact({ slug: 'demo' }),
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    },
  );
  it.each(['size', 'hash', 'limit', 'truncated'])(
    'rejects %s download before preparation',
    async (failure) => {
      const http: typeof fetch = async () =>
        failure === 'truncated'
          ? new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error('truncated body'));
                },
              }),
            )
          : new Response(
              new Uint8Array(
                failure === 'limit' ? Buffer.alloc(20 * 1024 * 1024 + 1) : registryBytes,
              ),
            );
      const artifact = {
        ...selected(),
        ...(failure === 'size'
          ? { size: registryBytes.length + 1 }
          : failure === 'hash'
            ? { sha256: 'a'.repeat(64) }
            : {}),
      };
      await expect(new RegistryClient(url, http).downloadArtifact(artifact)).rejects.toMatchObject({
        code:
          failure === 'limit'
            ? 'INVALID_RESPONSE'
            : failure === 'truncated'
              ? 'DOWNLOAD_FAILED'
              : 'ARTIFACT_MISMATCH',
      });
    },
  );
  it.each(['expired', '401', '403'])(
    'refreshes %s once for the resolved version instead of latest',
    async (failure) => {
      const http = vi.fn<typeof fetch>(async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/old') return new Response(null, { status: Number(failure) });
        if (path === '/fresh') return new Response(new Uint8Array(registryBytes));
        return Response.json(artifact(`${url}/fresh`));
      });
      const original = artifact(
        `${url}/old`,
        failure === 'expired' ? { expiresAt: '2000-01-01T00:00:00Z' } : {},
      );
      expect((await new RegistryClient(url, http).downloadArtifact(original)).bytes).toEqual(
        registryBytes,
      );
      const requests = http.mock.calls.map(([input]) => String(input));
      expect(requests.filter((path) => path.includes('/api/'))).toEqual([
        `${url}/api/v1/skills/demo/artifact?version=1.2.3`,
      ]);
      expect(requests.filter((path) => path.endsWith('/old'))).toHaveLength(
        failure === 'expired' ? 0 : 1,
      );
    },
  );
  it.each(['hash', 'size', 'version', 'slug', 'expired', 'repeated-403'])(
    'rejects refresh %s without another retry',
    async (failure) => {
      const http = vi.fn<typeof fetch>(async (input) =>
        String(input).includes('/api/')
          ? Response.json(
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
            )
          : new Response(null, { status: 403 }),
      );
      await expect(
        new RegistryClient(url, http).downloadArtifact(artifact(`${url}/old`)),
      ).rejects.toBeInstanceOf(Error);
      expect(http.mock.calls.filter(([input]) => String(input).includes('/api/'))).toHaveLength(1);
      expect(http).toHaveBeenCalledTimes(failure === 'repeated-403' ? 3 : 2);
    },
  );
  it('does not leak signed URLs in a transport error', async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('failed https://download.test?signature=secret'));
    await expect(
      new RegistryClient(url, http).downloadArtifact(
        artifact('https://download.test?signature=secret'),
      ),
    ).rejects.toMatchObject({
      message: 'Скачивание артефакта завершилось ошибкой или превысило время ожидания.',
    });
  });
});
