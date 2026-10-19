import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { symlink } from './helpers/links.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { withTestEnvironment } from './helpers/test-environment.ts';

it('keeps shared lock, all skill resources and agent links in Git while ignoring only state work files', async () => {
  await withTestEnvironment(async (fixture) => {
    const env = { ...fixture.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
    const initialized = spawnSync('git', ['init', '--quiet'], {
      cwd: fixture.roots.cwd,
      env,
      encoding: 'utf8',
    });
    expect(initialized.error).toBeUndefined();
    expect(initialized.status).toBe(0);
    await copyFile(
      fileURLToPath(new URL('../.gitignore', import.meta.url)),
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
    const links = ['.claude', '.pi'].map((directory) => `${directory}/skills/demo.tgz`);
    for (const path of links) {
      const absolute = join(fixture.roots.cwd, path);
      await mkdir(dirname(absolute), { recursive: true });
      await symlink('../../.agents/skills/demo', absolute);
    }
    const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
      cwd: fixture.roots.cwd,
      env,
      input: [...kept, ...links, ...ignored].join('\n') + '\n',
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n').sort()).toEqual([...ignored].sort());
  });
});
