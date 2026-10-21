import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { AGENTS } from '../../src/installer/agents.ts';
import { Installer } from '../../src/installer/installer.ts';
import type { InstallerOptions } from '../../src/installer/types.ts';
import type { InstallationScope } from '../../src/installer/types.ts';
import type { RuntimeContext } from '../../src/runtime.ts';
import { getStatePaths } from '../../src/state/paths.ts';
import { StateStore, defaultStateFileIO } from '../../src/state/store.ts';
import { Telemetry, type TelemetryEnvelope } from '../../src/telemetry/client.ts';

import { withTestEnvironment, type TestEnvironment } from '../helpers/test-environment.ts';
import { versionRegistry } from '../helpers/versions.ts';

const agents = AGENTS.map((agent) => agent.id);
function enabled(f: TestEnvironment, env: Record<string, string> = {}): RuntimeContext {
  return { ...f, env: { ...f.env, DISABLE_TELEMETRY: '', DO_NOT_TRACK: '', ...env } };
}
function tracking(
  f: TestEnvironment,
  scope: InstallationScope = 'project',
  options: InstallerOptions = {},
) {
  const backend = versionRegistry();
  const events: { url: string; payload: TelemetryEnvelope }[] = [];
  const context = {
    ...enabled(f),
    http: vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'POST') {
        events.push({
          url: String(input),
          payload: JSON.parse(String(init.body)) as TelemetryEnvelope,
        });
        return new Response(null, { status: 202 });
      }
      return backend.http(input, init);
    }),
  };
  const telemetry = new Telemetry(context, '0.1.0', { timeoutMs: 30 });
  const installer = new Installer(context, {
    scope,
    registry: backend.url,
    telemetry,
    ...options,
  });
  const flush = async <T>(operation: Promise<T>): Promise<T> => {
    try {
      return await operation;
    } finally {
      await telemetry.flush();
    }
  };
  return { backend, context, telemetry, installer, events, flush };
}

describe.each(['project'] as readonly ('project' | 'global')[])(
  '%s registry statistics',
  (scope) => {
    it('counts once for five agents, skips repeats and counts a new connection without download', async () =>
      withTestEnvironment(async (f) => {
        const { installer, events, flush, backend } = tracking(f, scope);
        expect((await flush(installer.add('demo', false, agents))).status).toBe('success');
        expect(events.map((e) => e.payload.event)).toEqual(['download', 'install']);
        expect(events[1]!.payload.context).toEqual({
          operation: 'add',
          scope,
          agents,
          version: '1.0.0',
          status: 'success',
        });
        const paths = getStatePaths(f.roots, scope);
        const lock = await readFile(paths.lockPath);
        expect((await flush(installer.add('demo', false, agents))).status).toBe('unchanged');
        expect(await readFile(paths.lockPath)).toEqual(lock);
        expect(events).toHaveLength(2);
        await installer.remove('demo', ['pi']);
        expect(events).toHaveLength(2);
        await flush(installer.add('demo', false, ['pi']));
        expect(events.map((e) => e.payload.event)).toEqual(['download', 'install', 'install']);
        expect(backend.requests.filter((url) => url.includes('/download/'))).toHaveLength(1);
        await installer.remove('demo');
        expect(events).toHaveLength(3);
        expect(new Set(events.map((e) => e.payload.eventId)).size).toBe(3);
      }));

    it('records failed install after a verified download and rolls back files on lock-write error', async () =>
      withTestEnvironment(async (f) => {
        const paths = getStatePaths(f.roots, scope);
        const store = new StateStore(paths, {
          ...defaultStateFileIO,
          writeTemporaryFile: async () => {
            throw new Error('write denied');
          },
        });
        const { installer, events, flush } = tracking(f, scope, { store });
        await expect(flush(installer.add('demo', false, agents))).rejects.toThrow('write denied');
        expect(events.map((e) => e.payload.event)).toEqual(['download', 'install']);
        expect(events[1]!.payload.context.status).toBe('failed');
        expect(await new StateStore(paths).read()).toBeNull();
        expect(await readdir(paths.skillsDirectory)).toEqual([]);
      }));

    it.each(['digest', 'invalid archive'] as const)(
      'records a failed update after %s validation and preserves the previous copy',
      async (failure) =>
        withTestEnvironment(async (f) => {
          const { installer, events, flush, backend, context } = tracking(f, scope);
          await flush(installer.add('demo', false, agents));
          events.length = 0;
          const paths = getStatePaths(f.roots, scope);
          const lock = await readFile(paths.lockPath);
          const copy = await readFile(join(paths.skillsDirectory, 'demo', 'SKILL.md'));
          backend.current.demo = '2.0.0';
          if (failure === 'invalid archive')
            backend.archives.set('demo@2.0.0', Buffer.from('not a tar.gz archive'));
          else {
            const original = context.http.getMockImplementation()!;
            context.http.mockImplementation(async (input, init) =>
              String(input).includes('/download/')
                ? new Response(new Uint8Array([1, 2, 3]))
                : original(input, init),
            );
          }
          expect((await flush(installer.update())).status).toBe('failed');
          expect(events.map((e) => e.payload.event)).toEqual(
            failure === 'digest' ? ['install'] : ['download', 'install'],
          );
          expect(events.at(-1)!.payload.context).toMatchObject({
            status: 'failed',
            version: '2.0.0',
          });
          expect(await readFile(paths.lockPath)).toEqual(lock);
          expect(await readFile(join(paths.skillsDirectory, 'demo', 'SKILL.md'))).toEqual(copy);
        }),
    );
  },
);
