import { describe, expect, it, vi } from 'vitest';
import { RegistryClient, getRegistryUrl, parseRegistryReference } from '@/registry';
import { TestRegistry } from '../helpers/registry.ts';

describe('package registry contract', () => {
  it('resolves current once and downloads an exact immutable skill ZIP', async () => {
    const registry = new TestRegistry();
    registry.release('docs', '1.2.0', ['check', 'compare']);
    const client = new RegistryClient(registry.url, registry.http);
    const release = await client.getPackage({ slug: 'docs' });
    registry.release('docs', '2.0.0', ['check']);
    const skill = release.skills[1]!;
    expect(skill.installName).toBe('docs-compare');
    expect(await client.downloadArtifact(skill)).toEqual(
      registry.releases.get('docs@1.2.0')![1]!.bytes,
    );
    expect(registry.requests).toEqual([
      '/api/v1/packages/docs',
      '/api/v1/packages/docs/components/skill/compare/artifact?version=1.2.0',
      '/download/docs/compare/1.2.0?signature=temporary',
    ]);
  });

  it('encodes a full version with build metadata and searches by q and kind', async () => {
    const registry = new TestRegistry();
    registry.release('docs', '1.2.0+abc', ['check']);
    registry.release('extra', '1.0.0', ['check']);
    const client = new RegistryClient(registry.url, registry.http);
    const release = await client.getPackage({ slug: 'docs', version: '1.2.0+abc' });
    expect(release.version).toBe('1.2.0+abc');
    const matches = await client.listSkills('CHECK');
    expect(matches.items.map(({ name, packageSlug }) => [name, packageSlug])).toEqual([
      ['check', 'docs'],
      ['check', 'extra'],
    ]);
    expect(registry.requests).toEqual([
      '/api/v1/packages/docs?version=1.2.0%2Babc',
      '/api/v1/components?kind=skill&q=CHECK&sort=popular&limit=10',
    ]);
  });

  it.each([
    { packageSlug: 'wrong' },
    { kind: 'plugin' },
    { name: 'wrong' },
    { version: '3.0.0' },
    { size: 17 },
    { sha256: 'a'.repeat(64) },
  ])('rejects inconsistent signed artifact %j before downloading', async (override) => {
    const registry = new TestRegistry();
    registry.release('docs', '1.0.0', ['check']);
    registry.artifactOverride = override;
    const client = new RegistryClient(registry.url, registry.http);
    const { skills } = await client.getPackage({ slug: 'docs' });
    await expect(client.downloadArtifact(skills[0]!)).rejects.toMatchObject({
      code: 'ARTIFACT_MISMATCH',
    });
    expect(registry.requests).toHaveLength(2);
  });

  it('rejects mismatched package version or component identity', async () => {
    const registry = new TestRegistry();
    registry.release('docs', '1.0.0', ['check']);
    registry.releases.get('docs@1.0.0')![0]!.wire.packageSlug = 'other';
    await expect(
      new RegistryClient(registry.url, registry.http).getPackage({ slug: 'docs' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('checks actual archive bytes even when size matches', async () => {
    const registry = new TestRegistry();
    registry.release('docs', '1.0.0', ['check']);
    registry.corrupt.add('docs/check');
    const client = new RegistryClient(registry.url, registry.http);
    await expect(
      client.downloadArtifact((await client.getPackage({ slug: 'docs' })).skills[0]!),
    ).rejects.toThrow(/SHA-256/);
  });

  it.each([403, 401])('refreshes the same artifact once after HTTP %s', async (status) => {
    const registry = new TestRegistry();
    registry.release('docs', '1.0.0', ['check']);
    let attempted = false;
    const client = new RegistryClient(registry.url, async (input, init) => {
      if (String(input).includes('/download/') && !attempted) {
        attempted = true;
        return new Response(null, { status });
      }
      return registry.http(input, init);
    });
    await client.downloadArtifact((await client.getPackage({ slug: 'docs' })).skills[0]!);
    expect(
      registry.requests.filter((path) => path.includes('/artifact?version=1.0.0')),
    ).toHaveLength(2);
  });

  it('passes the reason through when the caller aborts a release request', async () => {
    const controller = new AbortController();
    const http = vi.fn<typeof fetch>(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = new RegistryClient('https://registry.test', http).getPackage(
      { slug: 'docs' },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
  });

  it('parses package references and normalizes the base URL without credentials', () => {
    expect(parseRegistryReference('docs@1.2.3')).toEqual({ slug: 'docs', version: '1.2.3' });
    expect(parseRegistryReference('../docs')).toBeNull();
    expect(() => parseRegistryReference('docs@latest')).toThrow(/SemVer/);
    expect(getRegistryUrl(undefined, { SKILLS_API_URL: ' https://registry.test/ ' })).toBe(
      'https://registry.test',
    );
    expect(() => getRegistryUrl('https://name:pass@registry.test', {})).toThrow();
  });
});

it('does not send authentication and aborts a streaming body even if transport ignores the signal', async () => {
  const controller = new AbortController();
  const cancelled = vi.fn();
  const http = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.credentials).toBe('omit');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    return new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{'));
        },
        cancel: cancelled,
      }),
    );
  });
  const pending = new RegistryClient('https://registry.test/proxy', http).getPackage(
    { slug: 'docs' },
    controller.signal,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await expect(pending).rejects.toBe(controller.signal.reason);
  expect(cancelled).toHaveBeenCalledOnce();
  expect(String(http.mock.calls[0]![0])).toBe('https://registry.test/proxy/api/v1/packages/docs');
});
