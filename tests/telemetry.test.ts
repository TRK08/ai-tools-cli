import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/cli/program.ts';
import { AGENTS } from '../src/installer/agents.ts';
import { Installer } from '../src/installer/installer.ts';
import type { InstallerOptions } from '../src/installer/types.ts';
import type { InstallationScope } from '../src/installer/types.ts';
import type { RuntimeContext } from '../src/runtime.ts';
import { getStatePaths } from '../src/state/paths.ts';
import { StateStore, defaultStateFileIO } from '../src/state/store.ts';
import {
  Telemetry,
  type RegistryEventContext,
  type TelemetryEnvelope,
} from '../src/telemetry/client.ts';
import { archiveBytes, skillText } from './helpers/archive.ts';
import { runCli } from './helpers/cli.ts';
import { skillDetail } from './helpers/discovery.ts';
import { json, withRegistryServer } from './helpers/registry.ts';
import { withTestEnvironment, type TestEnvironment } from './helpers/test-environment.ts';
import { versionArtifact, versionBytes, versionRegistry } from './helpers/versions.ts';

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

describe.each(['project', 'global'] as const)('%s registry statistics', (scope) => {
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

  it('skips policy-only unpin and exact update; emits update for the saved source', async () =>
    withTestEnvironment(async (f) => {
      const { installer, events, flush, backend } = tracking(f, scope);
      await flush(installer.add('demo@1.0.0', false, agents));
      events.length = 0;
      backend.current.demo = '2.0.0';
      expect((await flush(installer.update())).results[0]!.status).toBe('pinned');
      expect(events).toEqual([]);
      backend.current.demo = '1.0.0';
      await flush(installer.add('demo', false, ['codex']));
      expect(events).toEqual([]);
      backend.current.demo = '2.0.0';
      const batch = await flush(installer.update('demo', false, ['codex']));
      expect(batch.status).toBe('success');
      expect(events.map((e) => e.payload.event)).toEqual(['download', 'install']);
      expect(events[1]!.payload.context).toMatchObject({
        operation: 'update',
        scope,
        version: '2.0.0',
        agents: [...agents].sort(),
        status: 'success',
      });
      expect(events.every((e) => e.url === `${backend.url}/api/v1/skills/events`)).toBe(true);
      events.length = 0;
      await flush(installer.update());
      expect(events).toEqual([]);
    }));

  it.each(['partial', 'failed'] as const)(
    'records %s once and preserves the installation outcome',
    async (status) =>
      withTestEnvironment(async (f) => {
        const paths = getStatePaths(f.roots, scope);
        const foreign = join(
          scope === 'project' ? f.roots.cwd : f.roots.home,
          '.claude',
          'skills',
          'demo',
        );
        await mkdir(foreign, { recursive: true });
        await writeFile(join(foreign, 'keep'), 'foreign');
        const { installer, events, flush } = tracking(f, scope);
        const result = await flush(
          installer.add(
            'demo',
            false,
            status === 'partial' ? ['codex', 'claude-code'] : ['claude-code'],
          ),
        );
        expect(result.status).toBe(status);
        expect(events.map((e) => e.payload.event)).toEqual(['download', 'install']);
        expect(events[1]!.payload.context.status).toBe(status);
        expect(await readFile(join(foreign, 'keep'), 'utf8')).toBe('foreign');
        const lock = await new StateStore(paths).read();
        if (status === 'partial') expect(lock!.skills.demo!.agents).toEqual(['codex']);
        else expect(lock).toBeNull();
      }),
  );

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

  it('records metadata failures without downloads and continues other updates', async () =>
    withTestEnvironment(async (f) => {
      const { installer, events, flush, backend } = tracking(f, scope);
      await flush(installer.add('demo', false, agents));
      await flush(installer.add('other', false, agents));
      events.length = 0;
      backend.failures.add('demo');
      backend.current.other = '2.0.0';
      const result = await flush(installer.update());
      expect(result.status).toBe('failed');
      expect(
        events.map((e) => [e.payload.skill.name, e.payload.event, e.payload.context.status]),
      ).toEqual([
        ['demo', 'install', 'failed'],
        ['other', 'download', undefined],
        ['other', 'install', 'success'],
      ]);
      expect(events[0]!.payload.context.version).toBeUndefined();
    }));

  it.each(['decline', 'cancel'] as const)('does not count update %s', async (decision) =>
    withTestEnvironment(async (f) => {
      const { installer, events, flush, backend, context, telemetry } = tracking(f, scope);
      await flush(installer.add('demo', false, agents));
      events.length = 0;
      backend.current.demo = '2.0.0';
      const updater = new Installer(context, {
        scope,
        telemetry,
        reviewUpdate: async () => decision,
      });
      expect((await flush(updater.update())).results[0]).toMatchObject({ status: 'skipped' });
      expect(events).toEqual([]);
    }),
  );

  it('repairs a missing registered connection without downloading', async () =>
    withTestEnvironment(async (f) => {
      const { installer, events, flush } = tracking(f, scope);
      await flush(installer.add('demo', false, ['codex', 'claude-code']));
      events.length = 0;
      await rm(join(scope === 'project' ? f.roots.cwd : f.roots.home, '.claude', 'skills', 'demo'));
      await flush(installer.update());
      expect(events.map((e) => e.payload.event)).toEqual(['install']);
      expect(events[0]!.payload.context.operation).toBe('update');
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
});

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

  it('does not send events for local directories or archives', async () =>
    withTestEnvironment(async (f) => {
      const http = vi.fn<typeof fetch>();
      const context = { ...enabled(f), http };
      const telemetry = new Telemetry(context, '0.1.0');
      const installer = new Installer(context, { telemetry });
      const source = join(f.roots.cwd, 'source');
      await mkdir(source);
      await writeFile(join(source, 'SKILL.md'), skillText);
      await installer.add(source);
      await installer.remove('demo');
      const archive = join(f.roots.cwd, 'demo.tgz');
      await writeFile(archive, archiveBytes([{ path: 'SKILL.md', contents: skillText }]));
      await installer.add(archive);
      await telemetry.flush();
      expect(http).not.toHaveBeenCalled();
    }));

  it('does not send events or HTTP on menu cancellation', async () =>
    withTestEnvironment(async (f) => {
      const http = vi.fn<typeof fetch>();
      const context = { ...enabled(f), http };
      const inputStream = new PassThrough();
      Object.assign(inputStream, { isTTY: true, setRawMode: vi.fn() });
      const output = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });
      Object.assign(output, { isTTY: true });
      const program = createProgram(
        '0.1.0',
        context,
        { write: vi.fn() },
        { input: inputStream, output },
      );
      const pending = program.parseAsync(['add', 'demo'], { from: 'user' });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      inputStream.write('\u001b');
      await pending;
      expect(http).not.toHaveBeenCalled();
      expect(await readdir(f.roots.cwd)).toEqual([]);
      inputStream.destroy();
    }));
});

describe('wire events through a real HTTP server and CLI', () => {
  it('uses registry override, saved source, endpoint override and command/global opt-out', async () => {
    let current = '1.0.0';
    const events: { path: string; payload: TelemetryEnvelope }[] = [];
    await withRegistryServer(
      async ({ url }) =>
        withTestEnvironment(async (f) => {
          const context = enabled(f, { SKILLS_API_URL: 'http://127.0.0.1:1' });
          expect(
            (
              await runCli(context, [
                'add',
                '--yes',
                'demo',
                '--registry',
                `${url}/prefix`,
                ...agents.flatMap((id) => ['-a', id]),
              ])
            ).status,
          ).toBe(0);
          expect(events.map((e) => e.path)).toEqual([
            '/prefix/api/v1/skills/events',
            '/prefix/api/v1/skills/events',
          ]);
          expect(events.map((e) => e.payload.event)).toEqual(['download', 'install']);
          expect(events[1]!.payload.context.agents).toEqual(agents);
          current = '2.0.0';
          const override = {
            ...context,
            env: { ...context.env, SKILLS_TELEMETRY_ENDPOINT: `${url}/custom-events` },
          };
          expect((await runCli(override, ['update', '--yes'])).status).toBe(0);
          expect(events.slice(2).map((e) => e.path)).toEqual(['/custom-events', '/custom-events']);
          expect(events[3]!.payload.context).toMatchObject({
            operation: 'update',
            version: '2.0.0',
          });
          const count = events.length;
          for (const args of [
            [
              'add',
              '--yes',
              'demo@1.0.0',
              '-a',
              'codex',
              '--without-stat',
              '--registry',
              `${url}/prefix`,
            ],
            [
              'add',
              '--yes',
              'demo',
              '-a',
              'codex',
              '--without-stat',
              '--registry',
              `${url}/prefix`,
            ],
          ]) {
            expect((await runCli(context, args)).status).toBe(0);
            expect(events).toHaveLength(count);
          }
          for (const args of [
            ['update', '--yes', '--without-stat'],
            ['--without-stat', 'update', '--yes'],
          ]) {
            current = `${Number(current.split('.')[0]) + 1}.0.0`;
            expect((await runCli(context, args)).status).toBe(0);
            expect(events).toHaveLength(count);
          }
          for (const flag of ['DISABLE_TELEMETRY', 'DO_NOT_TRACK']) {
            current = `${Number(current.split('.')[0]) + 1}.0.0`;
            expect(
              (
                await runCli({ ...context, env: { ...context.env, [flag]: '1' } }, [
                  'update',
                  '--yes',
                ])
              ).status,
            ).toBe(0);
            expect(events).toHaveLength(count);
          }
        }),
      (request, response, url) => {
        if (request.method === 'POST') {
          let body = '';
          request.on('data', (data) => {
            body += data;
          });
          request.on('end', () => {
            events.push({ path: request.url!, payload: JSON.parse(body) as TelemetryEnvelope });
            response.writeHead(202);
            response.end();
          });
          return;
        }
        if (request.url!.startsWith('/prefix/api/v1/skills/demo/artifact')) {
          const version = new URL(request.url!, url).searchParams.get('version') ?? current;
          return json(response, versionArtifact(`${url}/prefix`, 'demo', version));
        }
        const parsed = new URL(request.url!, url);
        if (parsed.pathname === '/prefix/api/v1/skills/demo') {
          const version = parsed.searchParams.get('version') ?? current;
          return json(
            response,
            skillDetail({
              currentVersion: current,
              version,
              versions: [...new Set([current, version])],
            }),
          );
        }
        const match = /\/download\/demo\/([^?]+)/.exec(request.url!);
        if (match) {
          response.end(versionBytes('demo', match[1]!));
          return;
        }
        json(response, {}, 404);
      },
    );
  });

  it.each(['HTTP 503', 'timeout'] as const)(
    'keeps CLI files, lock and exit codes after telemetry %s',
    async (failure) => {
      await withRegistryServer(
        async ({ url }) =>
          withTestEnvironment(async (f) => {
            const context = enabled(f, { SKILLS_API_URL: url });
            const added = await runCli(context, ['add', '--yes', 'demo', '-a', 'codex']);
            expect(added).toMatchObject({ status: 0, stderr: '' });
            const paths = getStatePaths(f.roots, 'project');
            const before = await readFile(paths.lockPath);
            expect(
              await readFile(join(paths.skillsDirectory, 'demo', 'SKILL.md'), 'utf8'),
            ).toContain('name: demo');
            await mkdir(join(f.roots.cwd, '.claude', 'skills', 'demo'), { recursive: true });
            const failed = await runCli(context, ['add', '--yes', 'demo', '-a', 'claude-code']);
            expect(failed.status).toBe(1);
            expect(await readFile(paths.lockPath)).toEqual(before);
            expect(await readdir(paths.agentsDirectory)).toEqual(['skills']);
          }),
        (request, response, url) => {
          if (request.method === 'POST') {
            if (failure === 'HTTP 503') json(response, {}, 503);
            return;
          }
          if (request.url!.startsWith('/api/v1/skills/demo/artifact'))
            return json(response, versionArtifact(url, 'demo', '1.0.0'));
          if (new URL(request.url!, url).pathname === '/api/v1/skills/demo')
            return json(
              response,
              skillDetail({ currentVersion: '1.0.0', version: '1.0.0', versions: ['1.0.0'] }),
            );
          if (request.url!.startsWith('/download/')) {
            response.end(versionBytes('demo', '1.0.0'));
            return;
          }
          json(response, {}, 404);
        },
      );
    },
  );
});
