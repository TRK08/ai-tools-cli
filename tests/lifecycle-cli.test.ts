import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTestEnvironment, type TestEnvironment } from './helpers/test-environment.js';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const skillText = '---\nname: demo\ndescription: Demo\n---\nOriginal\n';

function cli(context: TestEnvironment, args: string[]) {
  if (args[0] === 'add') args = [...args, '--yes'];
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
      expect(added.stdout).toContain('Установлен demo (codex).');
      expect(added.stderr).toBe('');
      const link = join(context.roots.cwd, '.agents', 'skills', 'demo');
      const lockPath = join(context.roots.cwd, 'skills-installer-lock.json');
      expect((await lstat(link)).isDirectory()).toBe(true);
      expect((await lstat(link)).isSymbolicLink()).toBe(false);
      const lock = JSON.parse(await readFile(lockPath, 'utf8'));
      expect(lock.skills.demo.agents).toEqual(['codex']);
      expect(lock.skills.demo.connections).toEqual([
        { agent: 'codex', kind: 'direct' as const, path: '.agents/skills/demo' },
      ]);
      expect(cli(context, ['add', './demo', '-a', 'codex']).stdout).toContain('Без изменений demo');
      const listed = cli(context, ['list']);
      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain('Установленные скиллы · текущий проект');
      expect(listed.stdout).toContain('Версия');
      expect(listed.stdout).not.toContain('Обновление');
      expect(listed.stdout).not.toContain('Источник');
      expect(listed.stdout).not.toContain('Подключения');
      expect(listed.stdout).toContain('Агенты');
      expect(listed.stdout).toMatch(/│ demo\s+│ локальная\s+│ codex\s+│/);
      expect(listed.stdout).not.toContain('.agents/skills/demo');
      expect(listed.stdout).toContain('Скиллов: 1 · Подключений: 1.');
      expect(cli(context, ['list', '-a', 'codex']).stdout).toContain('фильтр: codex');
      const removed = cli(context, ['remove', 'demo', '-a', 'codex', '--yes']);
      expect(removed.status).toBe(0);
      expect(removed.stdout).toMatch(/│ demo\s+│ локальная\s+│ Удалён\s+│ codex\s+│/);
      await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        lstat(join(context.roots.cwd, '.agents', 'skills', 'demo')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.parse(await readFile(lockPath, 'utf8')).skills).toEqual({});
      expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toBe(skillText);
      expect(cli(context, ['list']).stdout).toContain('Нет скиллов');
      expect(cli(context, ['remove', 'demo', '--yes']).status).toBe(0);
    });
  });

  it('updates sources, rejects manual edits without force, then removes edited contents', async () => {
    await withTestEnvironment(async (context) => {
      const path = await source(context);
      expect(cli(context, ['add', './demo', '-a', 'codex']).status).toBe(0);
      await writeFile(join(path, 'new'), 'updated resource');
      const updated = cli(context, ['add', './demo', '-a', 'codex']);
      expect(updated.status).toBe(0);
      expect(updated.stdout).toContain('затрагиваемые агенты: codex');
      const installedSkill = join(context.roots.cwd, '.agents', 'skills', 'demo', 'SKILL.md');
      await writeFile(installedSkill, 'user edits');
      const rejected = cli(context, ['add', './demo', '-a', 'codex']);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('--force');
      expect(await readFile(installedSkill, 'utf8')).toBe('user edits');
      expect(cli(context, ['add', './demo', '-a', 'codex', '--force']).status).toBe(0);
      expect(await readFile(installedSkill, 'utf8')).toBe(skillText);
      await writeFile(installedSkill, 'other user edits');
      expect(cli(context, ['remove', 'demo', '--yes']).status).toBe(0);
      expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toBe(skillText);
    });
  });

  it.each([
    { args: ['add', './demo'], message: /TTY.*укажите -a/ },
    { args: ['add', './demo', '-a', 'unknown'], message: /Неизвестный агент/ },
    { args: ['list', '-a', 'unknown'], message: /Неизвестный агент/ },
    { args: ['remove', 'demo', '-a', 'unknown'], message: /Неизвестный агент/ },
    { args: ['remove'], message: /TTY.*remove demo --yes/ },
    { args: ['add'], message: /отсутствует обязательный аргумент/ },
    { args: ['remove', '../demo'], message: /Небезопасное имя скилла/ },
    { args: ['remove', 'demo', '--force'], message: /неизвестный параметр/ },
    { args: ['add', './demo', '-a', 'codex', 'extra'], message: /слишком много аргументов/ },
    { args: ['restore'], message: /Ошибка: .*restore/ },
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

  it('supports multiple agents and independent global scope without TTY', async () => {
    await withTestEnvironment(async (context) => {
      await source(context);
      const args = ['add', './demo', '-a', 'cursor', '-a', 'pi'];
      expect(cli(context, args).status).toBe(0);
      expect(cli(context, [...args, '-g']).status).toBe(0);
      expect(cli(context, ['list', '-g', '-a', 'pi']).stdout).toContain(
        'Установленные скиллы · глобальная область · фильтр: pi',
      );
      expect(cli(context, ['list', '-a', 'codex']).stdout).toContain('Нет скиллов');
      expect(cli(context, ['remove', 'demo', '-a', 'pi', '--yes']).status).toBe(0);
      expect(cli(context, ['list']).stdout).toContain('cursor');
      expect(cli(context, ['remove', 'demo', '-g', '--yes']).status).toBe(0);
      expect(cli(context, ['list', '-g']).stdout).toContain('Нет скиллов');
    });
  });

  it('returns code 1 while preserving successful connections on partial add and remove', async () => {
    await withTestEnvironment(async (context) => {
      await source(context);
      const foreign = join(context.roots.cwd, '.claude', 'skills', 'demo');
      await mkdir(foreign, { recursive: true });
      const added = cli(context, ['add', './demo', '-a', 'codex', '-a', 'claude-code']);
      expect(added.status).toBe(1);
      expect(added.stderr).toContain('Частичный результат');
      expect(cli(context, ['list']).stdout).toContain('codex');
      expect((await lstat(foreign)).isDirectory()).toBe(true);
      await rm(foreign, { recursive: true });
      expect(cli(context, ['add', './demo', '-a', 'claude-code']).status).toBe(0);
      await rm(foreign);
      await mkdir(foreign);
      const removed = cli(context, ['remove', 'demo', '--yes']);
      expect(removed.status).toBe(1);
      expect(removed.stderr).toContain('Путь агента занят чужим объектом');
      expect(cli(context, ['list']).stdout).toContain('claude-code');
      expect((await lstat(foreign)).isDirectory()).toBe(true);
    });
  });

  it('reports preparation and foreign destination failures with code 1', async () => {
    await withTestEnvironment(async (context) => {
      const path = await source(context);
      const result = cli(context, ['add', './missing', '-a', 'codex']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Не удалось подготовить локальный источник');
      await mkdir(join(context.roots.cwd, '.agents', 'skills'), { recursive: true });
      const link = join(context.roots.cwd, '.agents', 'skills', 'demo');
      await symlink(path, link);
      const conflict = cli(context, ['add', './demo', '-a', 'codex', '--force']);
      expect(conflict.status).toBe(1);
      expect(conflict.stderr).toContain('Общий каталог занят чужим объектом');
      expect(await readlink(link)).toBe(path);
      await rm(link);
    });
  });
});
