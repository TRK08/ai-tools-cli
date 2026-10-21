import { describe, expect, it, vi } from 'vitest';

import type { RuntimeContext } from '../../src/runtime.ts';

import { Telemetry, type RegistryEventContext } from '../../src/telemetry/client.ts';

import { withTestEnvironment, type TestEnvironment } from '../helpers/test-environment.ts';

function enabled(f: TestEnvironment, env: Record<string, string> = {}): RuntimeContext {
  return { ...f, env: { ...f.env, DISABLE_TELEMETRY: '', DO_NOT_TRACK: '', ...env } };
}

describe('best-effort telemetry transport', () => {
  const input: RegistryEventContext = {
    registryUrl: 'https://registry.example.test/prefix',
    slug: 'demo',
    version: '1.0.0',
    operation: 'add',
    scope: 'project',
    agents: ['codex'],
  };
  it.each(['DISABLE_TELEMETRY', 'DO_NOT_TRACK'] as const)(
    'disables with nonempty %s',
    async (flag) =>
      withTestEnvironment(async (f) => {
        const http = vi.fn<typeof fetch>();
        const telemetry = new Telemetry({ ...enabled(f, { [flag]: '1' }), http }, '0.1.0');
        telemetry.emit('download', input);
        telemetry.emit('install', input, 'success');
        await telemetry.flush();
        expect(http).not.toHaveBeenCalled();
      }),
  );

  it.each(['http://127.0.0.1:8123/custom', 'https://stats.example.test/events?key=test'])(
    'uses override %s and sends a v1 envelope',
    async (endpoint) =>
      withTestEnvironment(async (f) => {
        const http = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
        const telemetry = new Telemetry(
          { ...enabled(f, { SKILLS_TELEMETRY_ENDPOINT: endpoint }), http },
          '0.1.0',
        );
        telemetry.emit('install', input, 'success');
        await telemetry.flush();
        expect(String(http.mock.calls[0]![0])).toBe(endpoint);
        const options = http.mock.calls[0]![1]!;
        const envelope = JSON.parse(String(options.body));
        expect(options).toMatchObject({
          method: 'POST',
          credentials: 'omit',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
        });
        expect(envelope).toMatchObject({
          schemaVersion: 1,
          event: 'install',
          cliVersion: '0.1.0',
          skill: { name: 'demo', sourceType: 'registry', source: input.registryUrl },
          context: { operation: 'add', status: 'success' },
        });
        expect(envelope.eventId).toMatch(/^[0-9a-f-]{36}$/);
        expect(Number.isFinite(Date.parse(envelope.occurredAt))).toBe(true);
      }),
  );

  it.each([
    'bad url',
    'file:///tmp/events',
    'https://user:password@example.test/events',
    'https://stats.example.test/#fragment',
  ])('ignores invalid endpoint %s', async (endpoint) =>
    withTestEnvironment(async (f) => {
      const http = vi.fn<typeof fetch>();
      const telemetry = new Telemetry(
        { ...enabled(f, { SKILLS_TELEMETRY_ENDPOINT: endpoint }), http },
        '0.1.0',
      );
      telemetry.emit('install', input, 'failed');
      await telemetry.flush();
      expect(http).not.toHaveBeenCalled();
    }),
  );

  it.each(['reject', 'HTTP 503', 'stall', 'body stall'] as const)(
    'ignores %s within a bounded timeout',
    async (failure) =>
      withTestEnvironment(async (f) => {
        let signal: AbortSignal | null | undefined;
        const http: typeof fetch = async (_url, init) => {
          signal = init?.signal;
          if (failure === 'reject') throw new Error('network');
          if (failure === 'HTTP 503') return new Response('invalid JSON', { status: 503 });
          if (failure === 'body stall')
            return new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }));
          return new Promise<Response>(() => {});
        };
        vi.useFakeTimers();
        try {
          const telemetry = new Telemetry({ ...enabled(f), http }, '0.1.0', { timeoutMs: 50 });
          telemetry.emit('download', input);
          const delivery = telemetry.flush();
          await vi.advanceTimersByTimeAsync(50);
          await delivery;
          if (failure.includes('stall')) expect(signal?.aborted).toBe(true);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      }),
  );
});
