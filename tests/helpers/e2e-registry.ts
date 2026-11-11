import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { TestRegistry } from './registry.ts';

/** Запускает локальную модель core на HTTP и закрывает сервер и сокеты после сценария. */
export async function withE2eRegistry<T>(run: (registry: TestRegistry) => Promise<T>): Promise<T> {
  let registry: TestRegistry;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const result = await registry.http(registry.url + request.url, {
        ...(request.method && { method: request.method }),
        ...(chunks.length && { body: Buffer.concat(chunks).toString('utf8') }),
      });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  registry = new TestRegistry(`http://127.0.0.1:${address.port}`);
  try {
    return await run(registry);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    assert.deepEqual(registry.unexpected, []);
  }
}
