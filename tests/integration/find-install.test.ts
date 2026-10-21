import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/program.ts';

import { hashDirectory } from '../../src/state/hash.ts';
import { getStatePaths } from '../../src/state/paths.ts';
import type { TelemetryEnvelope } from '../../src/telemetry/client.ts';
import { catalogItem } from '../helpers/discovery.ts';

import { withTestEnvironment, type TestEnvironment } from '../helpers/test-environment.ts';

import { versionRegistry } from '../helpers/versions.ts';

function terminal(inputTTY = true, outputTTY = true, columns = 110) {
  let rendered = '';
  const input = Object.assign(new PassThrough(), {
    isTTY: inputTTY,
    isRaw: false,
    setRawMode: vi.fn((raw: boolean) => {
      input.isRaw = raw;
    }),
  });
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        rendered += String(chunk);
        done();
      },
    }),
    { isTTY: outputTTY, columns, rows: 24 },
  );
  return {
    input,
    output,
    rendered: () => rendered,
    current: () => {
      const start = rendered.lastIndexOf('\u001b[J');
      return start < 0 ? rendered : rendered.slice(start + 3);
    },
    close() {
      input.destroy();
      output.destroy();
    },
  };
}
const tick = () => new Promise<void>((done) => setImmediate(done));
async function keys(t: ReturnType<typeof terminal>, ...sequence: string[]) {
  await tick();
  for (const key of sequence) {
    t.input.write(key);
    await tick();
  }
}
const searchReady = (t: ReturnType<typeof terminal>) =>
  vi.waitFor(() => expect(t.current()).toContain('Найдите скилл для установки'), { interval: 5 });
const resultsReady = (t: ReturnType<typeof terminal>, reference = 'demo@1.0.0') =>
  vi.waitFor(
    () => {
      expect(t.current()).toContain(reference);
      expect(t.current()).not.toContain('Поиск в реестре');
    },
    { interval: 5 },
  );
const agentReady = (t: ReturnType<typeof terminal>) =>
  vi.waitFor(() => expect(t.rendered()).toContain('Выберите агентов'), { interval: 5 });
const enter = '\r';

function catalogRegistry(f: TestEnvironment) {
  const backend = versionRegistry();
  const items = [
    catalogItem({ currentVersion: '1.0.0', installCount: 12 }),
    catalogItem({
      slug: 'other',
      name: 'UI Tools',
      shortDescription: 'Frontend components',
      tags: ['web'],
      currentVersion: '1.0.0',
      installCount: 30,
    }),
  ];
  const events: TelemetryEnvelope[] = [];
  const requests: string[] = [];
  const http = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (init?.method === 'POST') {
      events.push(JSON.parse(String(init.body)) as TelemetryEnvelope);
      return new Response(null, { status: 202 });
    }
    const parsed = new URL(url);
    if (parsed.pathname === '/origin/api/v1/skills')
      return Response.json({
        items: items.filter((item) =>
          item.slug.startsWith(parsed.searchParams.get('slugPrefix') ?? ''),
        ),
      });
    return backend.http(input, init);
  });
  const context = {
    ...f,
    env: { ...f.env, DISABLE_TELEMETRY: '', DO_NOT_TRACK: '', SKILLS_API_URL: backend.url },
    http,
  };
  return { ...backend, context, items, events, requests, http };
}

it.each(['\u001b', '\u0003'])(
  'cancels agent selection with %j before metadata/download/events',
  async (key) =>
    withTestEnvironment(async (f) => {
      const registry = catalogRegistry(f),
        t = terminal();
      const before = await hashDirectory(f.temporaryRoot);
      try {
        const run = createProgram({
          version: '0.1.0',
          runtime: registry.context,
          stdin: t.input,
          stdout: t.output,
          stderr: t.output,
        }).parseAsync(['find', 'dem', '-g'], { from: 'user' });
        await searchReady(t);
        await resultsReady(t);
        await keys(t, enter);
        await agentReady(t);
        await keys(t, key);
        await run;
        expect(registry.requests).toEqual([`${registry.url}/api/v1/skills?slugPrefix=dem`]);
        expect(registry.events).toEqual([]);
        expect(await hashDirectory(f.temporaryRoot)).toBe(before);
        expect(t.input.isRaw).toBe(false);
      } finally {
        t.close();
      }
    }),
);
it.each(['project', 'global'] as const)(
  'uses initial query, explicit agents and --without-stat in %s scope',
  async (scope) =>
    withTestEnvironment(async (f) => {
      const registry = catalogRegistry(f),
        t = terminal();
      try {
        const flags = scope === 'global' ? ['-g'] : [];
        const run = createProgram({
          version: '0.1.0',
          runtime: registry.context,
          stdin: t.input,
          stdout: t.output,
          stderr: t.output,
        }).parseAsync(
          [
            'find',
            'dem',
            '-a',
            'pi',
            '-a',
            'pi',
            ...flags,
            '--without-stat',
            '--yes',
            '--registry',
            registry.url,
          ],
          { from: 'user' },
        );
        await searchReady(t);
        await resultsReady(t);
        expect(t.rendered()).toContain('dem');
        await keys(t, enter);
        if (scope === 'project') {
          await vi.waitFor(() => expect(t.rendered()).toContain('Область установки'), {
            interval: 5,
          });
          await keys(t, enter);
        }
        await run;
        const paths = getStatePaths(f.roots, scope),
          lock = JSON.parse(await readFile(paths.lockPath, 'utf8'));
        expect(lock.skills.demo).toMatchObject({
          version: '1.0.0',
          policy: 'latest',
          agents: ['pi'],
        });
        expect(t.rendered()).not.toContain('Выберите агентов');
        expect(registry.events).toEqual([]);
        registry.current.demo = '2.0.0';
        await createProgram({
          version: '0.1.0',
          runtime: registry.context,
          stdin: t.input,
          stdout: t.output,
          stderr: t.output,
        }).parseAsync(['update', 'demo', '--yes', '--without-stat', ...flags], { from: 'user' });
        expect(JSON.parse(await readFile(paths.lockPath, 'utf8')).skills.demo).toMatchObject({
          version: '2.0.0',
          policy: 'latest',
          agents: ['pi'],
        });
        expect(registry.requests).toContain(`${registry.url}/api/v1/skills/demo/artifact`);
        expect(registry.events).toEqual([]);
      } finally {
        t.close();
      }
    }),
);
it('installs the selected version with latest policy even when the registry current version changes', async () =>
  withTestEnvironment(async (f) => {
    const registry = catalogRegistry(f),
      t = terminal();
    try {
      // Both forms can be real local sources in add; find must retain its explicit registry identity.
      for (const name of ['demo', 'demo@1.0.0']) {
        const folder = join(f.roots.cwd, name);
        await mkdir(folder);
        await writeFile(
          join(folder, 'SKILL.md'),
          '---\nname: local-shadow\ndescription: Local\n---\n',
        );
      }
      const run = createProgram({
        version: '0.1.0',
        runtime: registry.context,
        stdin: t.input,
        stdout: t.output,
        stderr: t.output,
      }).parseAsync(['find', '--yes'], { from: 'user' });
      await searchReady(t);
      expect(registry.requests).toEqual([]);
      await keys(t, 'dem');
      await resultsReady(t);
      expect(t.rendered()).toContain('Совпадений: 1');
      expect(t.current()).toContain('demo@1.0.0 · 12 установок');
      expect(t.current()).not.toContain('API Contract Checker');
      expect(t.current()).not.toContain('Checks HTTP contracts');
      expect(registry.requests).toEqual([`${registry.url}/api/v1/skills?slugPrefix=dem`]);
      registry.current.demo = '2.0.0';
      await keys(t, enter);
      await vi.waitFor(() => expect(t.rendered()).toContain('Область установки'), {
        interval: 5,
      });
      await keys(t, enter);
      await agentReady(t);
      expect(registry.requests).toHaveLength(1);
      await keys(t, enter);
      await run;
      const record = JSON.parse(
        await readFile(join(f.roots.cwd, 'skills-installer-lock.json'), 'utf8'),
      ).skills.demo;
      expect(record).toMatchObject({
        source: { kind: 'registry', slug: 'demo', registryUrl: registry.url },
        policy: 'latest',
        version: '1.0.0',
        agents: ['codex', 'cursor', 'opencode', 'pi'],
      });
      expect(registry.requests).toContain(
        `${registry.url}/api/v1/skills/demo/artifact?version=1.0.0`,
      );
      expect(registry.events.map((e) => e.event)).toEqual(['download', 'install']);
      expect(registry.events[1]!.context).toMatchObject({
        operation: 'add',
        version: '1.0.0',
        status: 'success',
      });
      expect(await readFile(join(f.roots.cwd, 'demo', 'SKILL.md'), 'utf8')).toContain(
        'local-shadow',
      );
      expect(t.input.isRaw).toBe(false);
    } finally {
      t.close();
    }
  }));
