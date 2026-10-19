import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { assertGitResourceAttributes } from '../scripts/git-roundtrip.ts';
import { withTestEnvironment } from './helpers/test-environment.ts';

it.each(['text=auto', 'filter=fixture', 'ident', 'working-tree-encoding=UTF-16'])(
  'rejects nested %s before Git can transform skill bytes',
  async (attribute) => {
    await withTestEnvironment(async (fixture) => {
      const config = join(fixture.temporaryRoot, 'gitconfig');
      await writeFile(config, '');
      const env = {
        ...fixture.env,
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ATTR_NOSYSTEM: '1',
      };
      const git = (args: string[], cwd: string) => {
        const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        return result.stdout;
      };
      git(['init', '--quiet'], fixture.roots.cwd);
      await copyFile(
        fileURLToPath(new URL('../.gitattributes', import.meta.url)),
        join(fixture.roots.cwd, '.gitattributes'),
      );
      const resource = '.claude/skills/demo/nested/asset.txt';
      await mkdir(dirname(join(fixture.roots.cwd, resource)), { recursive: true });
      await writeFile(join(fixture.roots.cwd, resource), 'keep\r\nbytes\n');
      expect(() => assertGitResourceAttributes(git, fixture.roots.cwd, [resource])).not.toThrow();
      await writeFile(
        join(fixture.roots.cwd, '.claude/skills/demo/nested/.gitattributes'),
        `*.txt ${attribute}\n`,
      );
      expect(() => assertGitResourceAttributes(git, fixture.roots.cwd, [resource])).toThrow(
        'Git изменит bytes',
      );
    });
  },
);
