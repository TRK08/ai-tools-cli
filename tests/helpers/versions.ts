import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { HttpTransport } from '../../src/runtime.ts';
import { archiveBytes, skillText } from './archive.ts';
import { artifact } from './registry.ts';
import { skillDetail } from './discovery.ts';

export function versionBytes(name: string, version: string): Buffer {
  return archiveBytes([
    {
      path: 'SKILL.md',
      contents: `${skillText.replace('name: demo', `name: ${name}`)}Version ${version}\n`,
    },
    { path: 'resource', contents: Buffer.from([0, 255, 128]) },
    { path: 'run.sh', contents: '#!/bin/sh\nprintf version-demo\n', mode: 0o711 },
  ]);
}

export function versionArtifact(
  url: string,
  name: string,
  version: string,
  bytes = versionBytes(name, version),
) {
  return artifact(`${url}/download/${name}/${version}`, {
    slug: name,
    version,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

/** Mutable backend fixture; every call still passes through the real registry client. */
export function versionRegistry() {
  const url = 'https://registry.example.test/origin';
  const current: Record<string, string> = { demo: '1.0.0', other: '1.0.0' };
  const failures = new Set<string>();
  const archives = new Map<string, Buffer>();
  const requests: string[] = [];
  const bytesFor = (name: string, version: string) =>
    archives.get(`${name}@${version}`) ?? versionBytes(name, version);
  const http = vi.fn<HttpTransport>(async (input) => {
    const requested = new URL(String(input));
    requests.push(requested.href);
    if (requested.origin !== new URL(url).origin) throw new Error('Unexpected registry origin.');
    const match = /^\/origin\/api\/v1\/skills\/([^/]+)\/artifact$/.exec(requested.pathname);
    if (match) {
      const name = match[1]!;
      if (failures.has(name)) return new Response(null, { status: 503 });
      if (!Object.hasOwn(current, name)) return new Response(null, { status: 404 });
      const version = requested.searchParams.get('version') ?? current[name]!;
      return Response.json(versionArtifact(url, name, version, bytesFor(name, version)));
    }
    const detail = /^\/origin\/api\/v1\/skills\/([^/]+)$/.exec(requested.pathname);
    if (detail) {
      const name = detail[1]!;
      if (!Object.hasOwn(current, name)) return new Response(null, { status: 404 });
      const version = requested.searchParams.get('version') ?? current[name]!;
      return Response.json(
        skillDetail({
          slug: name,
          currentVersion: current[name],
          version,
          versions: [...new Set([current[name], version])],
        }),
      );
    }
    const download = /^\/origin\/download\/([^/]+)\/([^/]+)$/.exec(requested.pathname);
    if (!download) throw new Error(`Unexpected HTTP request: ${requested.href}`);
    return new Response(new Uint8Array(bytesFor(download[1]!, download[2]!)));
  });
  return { url, current, failures, archives, requests, http };
}
