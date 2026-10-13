import { spawnSync } from 'node:child_process';
import { chmod, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/cli/program.ts';
import { LocalInstaller } from '../src/installer/local.ts';
import { hashDirectory } from '../src/state/hash.ts';
import { getStatePaths } from '../src/state/paths.ts';
import { archiveBytes, skillText } from './helpers/archive.ts';
import { withTestEnvironment, type TestEnvironment } from './helpers/test-environment.ts';

function cli(f: TestEnvironment, args: string[]) {
  const result = spawnSync(
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
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

describe('archive CLI', () => {
  it.each(['tar.gz', 'tgz'])(
    'runs add/list/remove with %s in both scopes and returns errors without changes',
    async (extension) => {
      await withTestEnvironment(async (f) => {
        const path = join(f.roots.cwd, `demo.${extension}`);
        await writeFile(path, archiveBytes([{ path: 'SKILL.md', contents: skillText }]));
        // A read-only source remains usable and is never modified by installation.
        await chmod(path, 0o444);
        for (const scope of ['project', 'global'] as const) {
          const flags = scope === 'global' ? ['-g'] : [];
          const paths = getStatePaths(f.roots, scope);
          const added = cli(f, ['add', `./demo.${extension}`, '-a', 'codex', '-a', 'pi', ...flags]);
          expect(added.status).toBe(0);
          expect(added.stdout).toContain('Added demo');
          expect(added.stderr).toBe('');
          const listed = cli(f, ['list', ...flags]);
          expect(listed.status).toBe(0);
          expect(listed.stdout).toMatch(/│ demo\s+│ local\s+│ local\s+│/);
          expect(listed.stdout).toContain('codex, pi');
          expect(cli(f, ['add', path, '-a', 'pi', ...flags]).stdout).toContain('Unchanged demo');
          const before = {
            hash: await hashDirectory(join(paths.skillsDirectory, 'demo')),
            lock: await readFile(paths.lockPath),
          };
          const corrupt = join(f.roots.cwd, 'corrupt.tgz');
          await writeFile(corrupt, 'corrupt');
          const failed = cli(f, ['add', corrupt, '-a', 'codex', ...flags]);
          expect(failed.status).toBe(1);
          expect(failed.stderr).toContain('gzip-compressed tar');
          expect({
            hash: await hashDirectory(join(paths.skillsDirectory, 'demo')),
            lock: await readFile(paths.lockPath),
          }).toEqual(before);
          expect(cli(f, ['remove', 'demo', ...flags]).status).toBe(0);
          await expect(lstat(join(paths.skillsDirectory, 'demo'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
        expect((await lstat(path)).mode & 0o777).toBe(0o444);
      });
    },
  );

  it('requires explicit agents without TTY before inspecting an archive', async () => {
    await withTestEnvironment(async (f) => {
      const before = await hashDirectory(f.temporaryRoot);
      const result = cli(f, ['add', './missing.tgz']);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/TTY.*specify -a/);
      expect(await hashDirectory(f.temporaryRoot)).toBe(before);
    });
  });

  it.each(['project', 'global'] as const)(
    'installs archives through the real Clack selector in %s scope',
    async (scope) => {
      await withTestEnvironment(async (f) => {
        const path = join(f.roots.cwd, 'demo.tgz');
        await writeFile(path, archiveBytes([{ path: 'SKILL.md', contents: skillText }]));
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
          const run = createProgram('0.1.0', f, { write: vi.fn() }, { input, output }).parseAsync([
            'node',
            'skills-installer',
            'add',
            './demo.tgz',
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
            (await readdir(getStatePaths(f.roots, scope).agentsDirectory)).filter((name) =>
              name.includes('work-'),
            ),
          ).toEqual([]);
        } finally {
          input.destroy();
          output.destroy();
        }
      });
    },
  );

  it.each(['\u001b', '\u0003'])('cancels %j before touching an archive or state', async (key) => {
    await withTestEnvironment(async (f) => {
      const before = await hashDirectory(f.temporaryRoot);
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
        const run = createProgram('0.1.0', f, { write }, { input, output }).parseAsync([
          'node',
          'skills-installer',
          'add',
          './missing.tgz',
          '--force',
        ]);
        await new Promise<void>((done) => setImmediate(done));
        input.write(key);
        await run;
        expect(write).toHaveBeenCalledWith('Cancelled.');
        expect(await hashDirectory(f.temporaryRoot)).toBe(before);
      } finally {
        input.destroy();
        output.destroy();
      }
    });
  });
});
