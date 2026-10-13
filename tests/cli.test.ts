import { spawnSync } from 'node:child_process';
import { lstat, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { withTestEnvironment } from './helpers/test-environment.js';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tsxImport = import.meta.resolve('tsx');

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};

  async function visit(path: string): Promise<void> {
    const stats = await lstat(path);
    const name = relative(root, path);
    const mode = stats.mode.toString(8);

    if (stats.isSymbolicLink()) {
      entries[name] = `link:${mode}:${await readlink(path)}`;
    } else if (stats.isDirectory()) {
      entries[name] = `directory:${mode}`;
      for (const child of (await readdir(path)).sort()) {
        await visit(join(path, child));
      }
    } else {
      entries[name] = `file:${mode}:${(await readFile(path)).toString('base64')}`;
    }
  }

  await visit(root);
  return entries;
}

describe('CLI in a separate process', () => {
  it.each([
    {
      name: 'help',
      args: ['--help'],
      exitCode: 0,
      stdout: /Использование: skills-installer/,
      stderr: /^$/,
    },
    {
      name: 'version',
      args: ['--version'],
      exitCode: 0,
      stdout: /^0\.1\.0\s*$/,
      stderr: /^$/,
    },
    {
      name: 'install is not registered',
      args: ['install'],
      exitCode: 1,
      stdout: /^$/,
      stderr: /Ошибка: .*install/,
    },
    {
      name: 'unknown command',
      args: ['unknown-command'],
      exitCode: 1,
      stdout: /^$/,
      stderr: /Ошибка: .*unknown-command/,
    },
    {
      name: 'unknown option',
      args: ['--unknown-option'],
      exitCode: 1,
      stdout: /^$/,
      stderr: /неизвестный параметр '--unknown-option'/,
    },
    {
      name: 'missing source',
      args: ['add'],
      exitCode: 1,
      stdout: /^$/,
      stderr: /Ошибка: отсутствует обязательный аргумент 'source'/,
    },
    {
      name: 'missing agent value',
      args: ['add', '--agent'],
      exitCode: 1,
      stdout: /^$/,
      stderr: /Ошибка: для параметра '-a, --agent <agent>' не указано значение/,
    },
    {
      name: 'excess arguments',
      args: ['update', 'demo', 'other'],
      exitCode: 1,
      stdout: /^$/,
      stderr:
        /Ошибка: слишком много аргументов для команды 'update'. Ожидалось: 1, получено: 2: demo, other/,
    },
    {
      name: 'option suggestion',
      args: ['add', '--forc'],
      exitCode: 1,
      stdout: /^$/,
      stderr: /неизвестный параметр '--forc'\s+\(Возможно, вы имели в виду --force\?\)/,
    },
    ...['add', 'list', 'find', 'update', 'remove'].flatMap((command) =>
      [
        [command, '--help'],
        ['help', command],
      ].map((args) => ({
        name: `Russian help for ${args.join(' ')}`,
        args,
        exitCode: 0,
        stdout: new RegExp(`Использование: skills-installer ${command} \\[параметры\\]`),
        stderr: /^$/,
      })),
    ),
  ])('$name returns $exitCode without changing fixture files', async (scenario) => {
    await withTestEnvironment(
      async (fixture) => {
        await writeFile(join(fixture.roots.cwd, 'existing-project-file'), 'keep project');
        await writeFile(join(fixture.roots.home, 'existing-home-file'), 'keep home');
        const before = await snapshotTree(fixture.temporaryRoot);

        const result = spawnSync(
          process.execPath,
          ['--import', tsxImport, cliPath, ...scenario.args],
          {
            cwd: fixture.roots.cwd,
            env: fixture.env,
            encoding: 'utf8',
            timeout: 10_000,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(scenario.exitCode);
        expect(result.stdout).toMatch(scenario.stdout);
        if (scenario.args.includes('--help') || scenario.args[0] === 'help') {
          expect(result.stdout).toContain('Параметры:');
          expect(result.stdout).toContain('показать справку по команде');
          expect(result.stdout).not.toMatch(
            /Usage:|Options:|Arguments:|Commands:|display help|repeatable|\[options\]/,
          );
        }
        if (scenario.name === 'help') expect(result.stdout).not.toMatch(/^\s+info(?:\s|$)/m);
        expect(result.stderr).toMatch(scenario.stderr);
        expect(await snapshotTree(fixture.temporaryRoot)).toEqual(before);
      },
      { env: { TSX_DISABLE_CACHE: '1' } },
    );
  });
});
