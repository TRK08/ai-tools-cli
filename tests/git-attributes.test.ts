import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { assertGitResourceAttributes, createGitRunner } from './helpers/git.ts';
import { withTestEnvironment } from './helpers/test-environment.ts';

it.each(['text=auto', 'filter=fixture', 'ident', 'working-tree-encoding=UTF-16'])(
  'rejects nested %s before Git can transform skill bytes',
  async (attribute) => {
    await withTestEnvironment(async (fixture) => {
      const git = await createGitRunner(fixture);
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
