import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTestEnvironment, type TestEnvironment } from './helpers/test-environment.js';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const skillText = '---\nname: demo\ndescription: Demo\n---\nOriginal\n';

function cli(context: TestEnvironment, args: string[]) {
  const result = spawnSync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), cliPath, ...args],
    {
      cwd: context.roots.cwd,
      env: { ...context.env, TSX_DISABLE_CACHE: '1' },
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

async function source(context: TestEnvironment) {
  const path = join(context.roots.cwd, 'demo');
  await mkdir(path);
  await writeFile(join(path, 'SKILL.md'), skillText);
  return path;
}

describe('lifecycle CLI', () => {
  it('runs the full local cycle, accepts repeated agents and preserves the source', async () => {
    await withTestEnvironment(async (context) => {
      const path = await source(context);
      const added = cli(context, ['add', './demo', '-a', 'codex', '--agent', 'codex']);
      expect(added.status).toBe(0);
      expect(added.stdout).toContain('Added demo (codex).');
      expect(added.stderr).toBe('');
      const link = join(context.roots.cwd, '.agents', 'skills', 'demo');
      const lockPath = join(context.roots.cwd, 'skills-installer-lock.json');
      expect((await lstat(link)).isDirectory()).toBe(true);
      expect((await lstat(link)).isSymbolicLink()).toBe(false);
      const lock = JSON.parse(await readFile(lockPath, 'utf8'));
      expect(lock.skills.demo.agents).toEqual(['codex']);
      expect(lock.skills.demo.connections).toEqual([
        { agent: 'codex', path: '.agents/skills/demo' },
      ]);
      expect(cli(context, ['add', './demo', '-a', 'codex']).stdout).toContain('Unchanged demo');
      const listed = cli(context, ['list']);
      expect(listed.status).toBe(0);
      expect(listed.stdout).toBe('demo\tlocal\tcodex\n');
      expect(cli(context, ['list', '-a', 'codex']).stdout).toBe(listed.stdout);
      const removed = cli(context, ['remove', 'demo', '-a', 'codex']);
      expect(removed.status).toBe(0);
      expect(removed.stdout).toContain('Removed demo');
      await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        lstat(join(context.roots.cwd, '.agents', 'skills', 'demo')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.parse(await readFile(lockPath, 'utf8')).skills).toEqual({});
      expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toBe(skillText);
      expect(cli(context, ['list']).stdout).toContain('No skills');
      expect(cli(context, ['remove', 'demo']).status).toBe(0);
    });
  });

  it('updates sources, rejects manual edits without force, then removes edited contents', async () => {
    await withTestEnvironment(async (context) => {
      const path = await source(context);
      expect(cli(context, ['add', './demo', '-a', 'codex']).status).toBe(0);
      await writeFile(join(path, 'new'), 'updated resource');
      const updated = cli(context, ['add', './demo', '-a', 'codex']);
      expect(updated.status).toBe(0);
      expect(updated.stdout).toContain('affected agents: codex');
      const installedSkill = join(context.roots.cwd, '.agents', 'skills', 'demo', 'SKILL.md');
      await writeFile(installedSkill, 'user edits');
      const rejected = cli(context, ['add', './demo', '-a', 'codex']);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('--force');
      expect(await readFile(installedSkill, 'utf8')).toBe('user edits');
      expect(cli(context, ['add', './demo', '-a', 'codex', '--force']).status).toBe(0);
      expect(await readFile(installedSkill, 'utf8')).toBe(skillText);
      await writeFile(installedSkill, 'other user edits');
      expect(cli(context, ['remove', 'demo']).status).toBe(0);
      expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toBe(skillText);
    });
  });

  it.each([
    { args: ['add', './demo'], message: /specify -a codex/ },
    { args: ['add', './demo', '-a', 'cursor'], message: /Only Codex/ },
    { args: ['add', './demo', '-a', 'unknown'], message: /Only Codex/ },
    { args: ['add', './demo', '-a', 'codex', '-a', 'pi'], message: /Only Codex/ },
    { args: ['add', './demo', '-a', 'codex', '-g'], message: /unknown option/ },
    { args: ['list', '--global'], message: /unknown option/ },
    { args: ['list', '-a', 'pi'], message: /Only Codex/ },
    { args: ['remove'], message: /missing required argument/ },
    { args: ['add'], message: /missing required argument/ },
    { args: ['remove', '../demo'], message: /Unsafe skill name/ },
    { args: ['remove', 'demo', '--force'], message: /unknown option/ },
    { args: ['add', './demo', '-a', 'codex', 'extra'], message: /too many arguments/ },
    { args: ['update'], message: /error: .*update/ },
    { args: ['restore'], message: /error: .*restore/ },
  ])('rejects unsupported arguments $args before changing state', async ({ args, message }) => {
    await withTestEnvironment(async (context) => {
      const path = await source(context);
      const result = cli(context, args);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(message);
      await expect(
        lstat(join(context.roots.cwd, 'skills-installer-lock.json')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        lstat(join(context.roots.cwd, '.agents', 'skills', 'demo')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toBe(skillText);
    });
  });

  it('reports preparation and foreign destination failures with code 1', async () => {
    await withTestEnvironment(async (context) => {
      const path = await source(context);
      const result = cli(context, ['add', './missing', '-a', 'codex']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Cannot prepare local source');
      await mkdir(join(context.roots.cwd, '.agents', 'skills'), { recursive: true });
      const link = join(context.roots.cwd, '.agents', 'skills', 'demo');
      await symlink(path, link);
      const conflict = cli(context, ['add', './demo', '-a', 'codex', '--force']);
      expect(conflict.status).toBe(1);
      expect(conflict.stderr).toContain('Foreign shared-copy');
      expect(await readlink(link)).toBe(path);
      await rm(link);
    });
  });
});
