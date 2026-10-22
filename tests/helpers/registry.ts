import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { RegistryArtifact } from '@/registry/client';
import { archiveBytes, skillText } from './archive.ts';
import { skillDetail } from './discovery.ts';

export const registryBytes = archiveBytes([
  { path: 'SKILL.md', contents: skillText },
  { path: 'resource', contents: Buffer.from([0, 255, 128]) },
  { path: 'run.sh', contents: '#!/bin/sh\nprintf registry-demo\n', mode: 0o711 },
]);

export function artifact(url: string, overrides: Partial<RegistryArtifact> = {}): RegistryArtifact {
  return {
    slug: 'demo',
    version: '1.2.3',
    sha256: createHash('sha256').update(registryBytes).digest('hex'),
    size: registryBytes.length,
    format: 'tar.gz',
    url,
    expiresAt: '2099-01-01T00:00:00Z',
    ...overrides,
  };
}

export function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

export async function withRegistryServer<T>(
  run: (server: { readonly url: string; readonly requests: string[] }) => Promise<T>,
  handler?: (
    request: IncomingMessage,
    response: ServerResponse,
    url: string,
    count: number,
  ) => void,
): Promise<T> {
  const requests: string[] = [];
  let url = '';
  const server = createServer((request, response) => {
    requests.push(request.url!);
    if (handler) return handler(request, response, url, requests.length);
    if (request.url!.startsWith('/api/v1/skills/demo/artifact')) {
      const version = new URL(request.url!, url).searchParams.get('version') ?? '1.2.3';
      return json(
        response,
        artifact(`${url}/download?signature=secret&expires=temporary`, { version }),
      );
    }
    if (request.url!.startsWith('/download')) {
      response.end(registryBytes);
      return;
    }
    const parsed = new URL(request.url!, url);
    if (parsed.pathname === '/api/v1/skills/demo') {
      const version = parsed.searchParams.get('version') ?? '1.2.3';
      return json(response, skillDetail({ version, versions: [...new Set(['1.2.3', version])] }));
    }
    json(
      response,
      { code: 'not_found', message: 'Skill or version not found', debugMessage: null },
      404,
    );
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address.');
    url = `http://127.0.0.1:${address.port}`;
    return await run({ url, requests });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}
