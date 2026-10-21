import { expect, it } from 'vitest';
import { RegistryClient } from '../../src/registry/client.ts';

import { artifact, registryBytes, withRegistryServer } from '../helpers/registry.ts';

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

it('reports a real truncated HTTP download body as a download failure', async () => {
  await withRegistryServer(
    async ({ url }) => {
      await expect(
        new RegistryClient(url, fetch).downloadArtifact(artifact(`${url}/download`)),
      ).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    },
    (_req, res) => {
      res.writeHead(200, { 'Content-Length': registryBytes.length + 100 });
      res.write(registryBytes);
      res.destroy();
    },
  );
});
