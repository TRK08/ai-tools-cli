import { spawn } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/cli/program.ts';
import { LocalInstaller } from '../src/installer/local.ts';
import { hashDirectory } from '../src/state/hash.ts';
import { getStatePaths } from '../src/state/paths.ts';
import { withRegistryServer } from './helpers/registry.ts';
import { withTestEnvironment, type TestEnvironment } from './helpers/test-environment.ts';

function cli(f: TestEnvironment, args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
        ...args,
      ],
      {
        cwd: f.roots.cwd,
        env: { ...f.env, TSX_DISABLE_CACHE: '1' },
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('error', reject);
    child.on('close', (status, signal) => {
      if (signal) reject(new Error(`CLI terminated by ${signal}`));
      else done({ status, stdout, stderr });
    });
    child.stdin.end();
  });
}

describe('registry CLI', () => {
  it.each(['project', 'global'] as const)(
    'runs latest/exact add/list/remove in %s scope with explicit registry priority',
    async (scope) => {
      await withRegistryServer(async ({ url, requests }) =>
        withTestEnvironment(
          async (f) => {
            const flags = scope === 'global' ? ['-g'] : [];
            const paths = getStatePaths(f.roots, scope);
            for (const source of ['demo', 'demo@1.2.3-rc.1+build.2']) {
              const result = await cli(f, [
                'add',
                source,
                '--registry',
                `${url}/`,
                '-a',
                'claude-code',
                '-a',
                'codex',
                '-a',
                'opencode',
                '-a',
                'pi',
                '-a',
                'cursor',
                ...flags,
              ]);
              expect(result).toMatchObject({
                status: 0,
                stderr: '',
                stdout: expect.stringContaining('Added demo'),
              });
              const listed = await cli(f, ['list', ...flags]);
              expect(listed.status).toBe(0);
              expect(listed.stdout).toContain('demo');
              expect(listed.stdout).toContain(source.includes('@') ? 'exact' : 'latest');
              expect(listed.stdout).toContain(
                source.includes('@') ? '1.2.3-rc.1+build.2' : '1.2.3',
              );
              expect(listed.stdout).not.toContain('secret');
              const oldLock = await readFile(paths.lockPath);
              const bad = await cli(f, [
                'add',
                'missing@1.2.3',
                '--registry',
                url,
                '-a',
                'codex',
                ...flags,
              ]);
              expect(bad.status).toBe(1);
              expect(bad.stderr).toMatch(/missing@1\.2\.3.*not found/);
              expect(await readFile(paths.lockPath)).toEqual(oldLock);
              expect((await cli(f, ['remove', 'demo', ...flags])).status).toBe(0);
              await expect(lstat(join(paths.skillsDirectory, 'demo'))).rejects.toMatchObject({
                code: 'ENOENT',
              });
            }
            expect(requests.every((p) => !p.includes('/events'))).toBe(true);
          },
          { env: { SKILLS_API_URL: 'http://127.0.0.1:1' } },
        ),
      );
    },
  );

  it('uses the environment registry in a child process', async () => {
    await withRegistryServer(async ({ url }) =>
      withTestEnvironment(
        async (f) => {
          expect((await cli(f, ['add', 'demo', '-a', 'codex'])).status).toBe(0);
          expect((await cli(f, ['list'])).stdout).toMatch(/│ demo\s+│ 1\.2\.3\s+│ latest\s+│/);
        },
        { env: { SKILLS_API_URL: url } },
      ),
    );
  });

  it.each(['project', 'global'] as const)(
    'installs registry skills through Clack in %s scope',
    async (scope) => {
      await withRegistryServer(async ({ url }) =>
        withTestEnvironment(
          async (f) => {
            const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
            const output = Object.assign(
              new Writable({
                write(_chunk, _encoding, done) {
                  done();
                },
              }),
              { isTTY: true, columns: 120 },
            );
            try {
              const run = createProgram(
                '0.1.0',
                f,
                { write: vi.fn() },
                { input, output },
              ).parseAsync([
                'node',
                'skills-installer',
                'add',
                'demo',
                ...(scope === 'global' ? ['-g'] : []),
              ]);
              await new Promise<void>((done) => setImmediate(done));
              input.write('\r');
              await run;
              expect((await new LocalInstaller(f, { scope }).list())[0]!.agents).toEqual([
                'claude-code',
                'codex',
                'opencode',
              ]);
              expect(
                (await readdir(getStatePaths(f.roots, scope).agentsDirectory)).filter((n) =>
                  n.includes('work-'),
                ),
              ).toEqual([]);
            } finally {
              input.destroy();
              output.destroy();
            }
          },
          { http: fetch, env: { SKILLS_API_URL: url } },
        ),
      );
    },
  );

  it.each(['\u001b', '\u0003'])(
    'cancels %j before registry resolution and state changes',
    async (key) => {
      await withTestEnvironment(async (f) => {
        const before = await hashDirectory(f.temporaryRoot);
        const http = vi.fn().mockRejectedValue(new Error('unexpected HTTP'));
        const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
        const output = Object.assign(
          new Writable({
            write(_chunk, _encoding, done) {
              done();
            },
          }),
          { isTTY: true, columns: 120 },
        );
        const write = vi.fn();
        try {
          const run = createProgram(
            '0.1.0',
            { ...f, http },
            { write },
            { input, output },
          ).parseAsync([
            'node',
            'skills-installer',
            'add',
            'demo@bad',
            '--registry',
            'invalid',
            '--force',
          ]);
          await new Promise<void>((done) => setImmediate(done));
          input.write(key);
          await run;
          expect(write).toHaveBeenCalledWith('Cancelled.');
          expect(http).not.toHaveBeenCalled();
          expect(await hashDirectory(f.temporaryRoot)).toBe(before);
        } finally {
          input.destroy();
          output.destroy();
        }
      });
    },
  );

  it('requires -a without TTY before registry access', async () => {
    await withTestEnvironment(async (f) => {
      const before = await hashDirectory(f.temporaryRoot);
      const result = await cli(f, ['add', 'demo', '--registry', 'invalid']);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/TTY.*specify -a/);
      expect(await hashDirectory(f.temporaryRoot)).toBe(before);
    });
  });
});
