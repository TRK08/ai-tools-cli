import assert from 'node:assert/strict';
import { catalogItem, skillDetail } from './discovery.ts';
import { json, withRegistryServer } from './registry.ts';
import { versionArtifact, versionBytes } from './versions.ts';

interface WireEvent {
  readonly schemaVersion: number;
  readonly event: string;
  readonly eventId: string;
  readonly cliVersion: string;
  readonly occurredAt: string;
  readonly skill: { readonly name: string; readonly sourceType: string; readonly source: string };
  readonly context: {
    readonly operation: string;
    readonly scope: string;
    readonly status?: string;
    readonly agents: readonly string[];
  };
}

/**
 * Запускает локальный registry по SkillCatalogItem/SkillDetail/SkillArtifact/SkillTelemetryEvent OpenAPI.
 * Caller меняет latest/отказы; сервер сохраняет запросы и события и закрывается вместе со всеми сокетами.
 * Неожиданный метод, маршрут или версия проваливает сценарий даже при best-effort telemetry.
 */
export async function withE2eRegistry<T>(
  run: (registry: {
    readonly url: string;
    readonly requests: string[];
    readonly events: WireEvent[];
    readonly state: { latest: string; corruptDownload: boolean; telemetryStatus: number };
  }) => Promise<T>,
): Promise<T> {
  const state = { latest: '1.0.0', corruptDownload: false, telemetryStatus: 202 };
  const versions = ['1.0.0', '2.0.0'];
  const events: WireEvent[] = [],
    unexpected: string[] = [];
  return withRegistryServer(
    async (server) => {
      try {
        return await run({ ...server, events, state });
      } finally {
        assert.deepEqual(unexpected, [], 'Unexpected registry requests or invalid event envelopes');
      }
    },
    (request, response, url) => {
      const parsed = new URL(request.url!, url),
        method = request.method;
      const reject = () => {
        unexpected.push(`${method} ${request.url}`);
        response.writeHead(501).end();
      };
      if (
        ['/api/v1/skills/events', '/custom-events'].includes(parsed.pathname) &&
        method === 'POST'
      ) {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          try {
            const event = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireEvent;
            assert.equal(event.schemaVersion, 1);
            assert.match(event.eventId, /^[0-9a-f-]{36}$/);
            assert.ok(event.cliVersion);
            assert.ok(Number.isFinite(Date.parse(event.occurredAt)));
            assert.ok(['download', 'install'].includes(event.event));
            assert.equal(event.skill.name, 'demo');
            assert.equal(event.skill.sourceType, 'registry');
            assert.equal(event.skill.source, url);
            assert.ok(['add', 'update'].includes(event.context.operation));
            assert.ok(['project', 'global'].includes(event.context.scope));
            assert.ok(Array.isArray(event.context.agents));
            if (event.event === 'install')
              assert.ok(['success', 'partial', 'failed'].includes(event.context.status!));
            events.push(event);
            response.writeHead(state.telemetryStatus).end();
          } catch {
            unexpected.push('invalid telemetry envelope');
            response.writeHead(400).end();
          }
        });
        return;
      }
      if (method !== 'GET') return reject();
      if (parsed.pathname === '/api/v1/skills') {
        if ([...parsed.searchParams.keys()].some((key) => key !== 'slugPrefix')) return reject();
        return json(response, {
          items: 'demo'.startsWith(parsed.searchParams.get('slugPrefix') ?? '')
            ? [catalogItem({ currentVersion: state.latest })]
            : [],
        });
      }
      const version = parsed.searchParams.get('version') ?? state.latest;
      if (
        parsed.pathname === '/api/v1/skills/demo' ||
        parsed.pathname === '/api/v1/skills/demo/artifact'
      ) {
        if (
          !versions.includes(version) ||
          [...parsed.searchParams.keys()].some((key) => key !== 'version')
        )
          return reject();
        return json(
          response,
          parsed.pathname.endsWith('/artifact')
            ? {
                ...versionArtifact(url, 'demo', version),
                url: `${url}/download/demo/${version}?signature=e2e-secret&expires=temporary`,
              }
            : skillDetail({
                version,
                currentVersion: state.latest,
                versions,
                skillMd: { url: `${url}/SKILL.md`, expiresAt: '2099-01-01T00:00:00Z' },
              }),
        );
      }
      const download = /^\/download\/demo\/(1\.0\.0|2\.0\.0)$/.exec(parsed.pathname);
      if (
        download &&
        parsed.searchParams.get('signature') === 'e2e-secret' &&
        parsed.searchParams.get('expires') === 'temporary'
      ) {
        const bytes = versionBytes('demo', download[1]!);
        response.end(
          state.corruptDownload ? Buffer.concat([bytes, Buffer.from('corrupt')]) : bytes,
        );
        return;
      }
      reject();
    },
  );
}
