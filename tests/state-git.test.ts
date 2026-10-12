import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { withTestEnvironment } from './helpers/test-environment.ts';

it('keeps shared lock, all skill resources and agent links in Git while ignoring only state work files', async () => {
  await withTestEnvironment(async (fixture) => {
    const env = { ...fixture.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
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
      '.skills-installer/lock.json',
      '.skills-installer/skills/demo/SKILL.md',
      '.skills-installer/skills/demo/resources.tgz',
      '.skills-installer/skills/demo/node_modules/resource/index.js',
      '.skills-installer/skills/demo/dist/asset.js',
      '.skills-installer/skills/demo/.DS_Store',
      '.skills-installer/skills/demo/.skills-installer/tmp/resource',
      '.skills-installer/skills/demo/.skills-installer/backups/resource',
      '.skills-installer/skills/demo/.skills-installer/operation.lock',
      'nested/.skills-installer/lock.json',
      'nested/.skills-installer/skills/demo/resources.tgz',
    ];
    const ignored = [
      '.skills-installer/tmp/lock-example.json',
      '.skills-installer/backups/demo/SKILL.md',
      '.skills-installer/operation.lock',
      'nested/.skills-installer/tmp/source/example',
      'nested/.skills-installer/backups/demo/SKILL.md',
      'nested/.skills-installer/operation.lock',
    ];
    for (const path of [...kept, ...ignored]) {
      const absolute = join(fixture.roots.cwd, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, 'fixture');
    }
    const links = ['.claude', '.agents', '.opencode', '.pi', '.cursor'].map(
      (directory) => `${directory}/skills/demo.tgz`,
    );
    for (const path of links) {
      const absolute = join(fixture.roots.cwd, path);
      await mkdir(dirname(absolute), { recursive: true });
      await symlink('../../.skills-installer/skills/demo', absolute);
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
