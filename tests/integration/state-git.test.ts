import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { withTestEnvironment } from '../helpers/test-environment.ts';

it('tracks shared files and Claude symlinks including deeply ignored resources while excluding state work files', async () => {
  await withTestEnvironment(async (fixture) => {
    const gitConfig = join(fixture.temporaryRoot, 'gitconfig');
    await writeFile(gitConfig, '', { flag: 'wx' });
    const env = { ...fixture.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig };
    const initialized = spawnSync('git', ['init', '--quiet'], {
      cwd: fixture.roots.cwd,
      env,
      encoding: 'utf8',
    });
    expect(initialized.error, `git init stderr:\n${initialized.stderr}`).toBeUndefined();
    expect(initialized.status, `git init stderr:\n${initialized.stderr}`).toBe(0);
    await copyFile(
      fileURLToPath(new URL('../../.gitignore', import.meta.url)),
      join(fixture.roots.cwd, '.gitignore'),
    );
    const kept = [
      'skills-installer-lock.json',
      'skills-lock.json',
      '.agents/skills/demo/SKILL.md',
      '.agents/skills/demo/resources.tgz',
      '.agents/skills/demo/node_modules/resource/index.js',
      '.agents/skills/demo/dist/asset.js',
      '.agents/skills/demo/.DS_Store',
      '.agents/skills/demo/.agents/.skills-installer-work-resource/file',
      '.agents/skills/demo/.skills-installer-lock-resource.tmp',
      '.agents/skills/demo/.skills-installer-operation.lock',
      'nested/skills-installer-lock.json',
      'nested/.agents/skills/demo/resources.tgz',
    ];
    const ignored = [
      '.agents/.skills-installer-work-example/previous/SKILL.md',
      '.skills-installer-operation.lock',
      '.skills-installer-lock-example.tmp',
      'nested/.agents/.skills-installer-work-example/source/skill/SKILL.md',
      'nested/.skills-installer-operation.lock',
      'nested/.skills-installer-lock-example.tmp',
    ];
    for (const path of [...kept, ...ignored]) {
      const absolute = join(fixture.roots.cwd, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, 'fixture');
    }
    for (const prefix of ['', 'nested/']) {
      const link = `${prefix}.claude/skills/demo`;
      await mkdir(dirname(join(fixture.roots.cwd, link)), { recursive: true });
      await symlink('../../.agents/skills/demo', join(fixture.roots.cwd, link), 'dir');
      kept.push(link);
    }
    const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
      cwd: fixture.roots.cwd,
      env,
      input: [...kept, ...ignored].join('\n') + '\n',
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n').sort()).toEqual([...ignored].sort());
    const added = spawnSync('git', ['add', '--all'], {
      cwd: fixture.roots.cwd,
      env,
      encoding: 'utf8',
    });
    expect(added.error, added.stderr).toBeUndefined();
    expect(added.status, added.stderr).toBe(0);
    const tracked = spawnSync('git', ['ls-files', '-z'], {
      cwd: fixture.roots.cwd,
      env,
      encoding: 'utf8',
    });
    expect(tracked.error, tracked.stderr).toBeUndefined();
    expect(tracked.status, tracked.stderr).toBe(0);
    expect(tracked.stdout.split('\0').filter(Boolean).sort()).toEqual(
      ['.gitignore', ...kept].sort(),
    );
  });
});
