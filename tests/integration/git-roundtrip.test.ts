import { copyFile, readFile, lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Installer } from '@/installer';
import { RegistryClient } from '@/registry';
import { getStatePaths, hashDirectory } from '@/state';
import { createGitRunner, assertGitResourceAttributes } from '../helpers/git.ts';
import { binaryResource, TestRegistry } from '../helpers/registry.ts';
import { runCliSync } from '../helpers/cli.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

it.each(['true', 'false'])(
  'keeps project ZIP bytes, lock paths and CLI remove through Git clone with autocrlf=%s',
  async (autocrlf) => {
    const registry = new TestRegistry();
    registry.release('docs', '1.0.0', ['check']);
    await withTestEnvironment(async (f) => {
      const context = { ...f, http: registry.http };
      const git = await createGitRunner(f);
      git(['init', '--quiet'], f.roots.cwd);
      git(['config', 'core.autocrlf', autocrlf], f.roots.cwd);
      git(['config', 'core.symlinks', 'true'], f.roots.cwd);
      await copyFile(
        fileURLToPath(new URL('../../.gitattributes', import.meta.url)),
        join(f.roots.cwd, '.gitattributes'),
      );
      const installer = new Installer(context, { scope: 'project' });
      const client = new RegistryClient(registry.url, registry.http);
      await installer.add(
        client,
        await client.getPackage({ slug: 'docs' }),
        [],
        ['codex', 'claude-code'],
        async () => 'approve',
      );
      const path = 'references/файл.bin';
      const copies = ['.agents/skills/docs-check', '.claude/skills/docs-check'];
      assertGitResourceAttributes(git, f.roots.cwd, [
        `${copies[0]}/SKILL.md`,
        `${copies[0]}/${path}`,
      ]);
      git(['add', '--all'], f.roots.cwd);
      git(['commit', '--quiet', '-m', 'fixture'], f.roots.cwd);
      expect(git(['ls-files', '--stage', copies[1]!], f.roots.cwd)).toMatch(/^120000 /);
      const clone = join(f.temporaryRoot, 'clone');
      git(
        [
          'clone',
          '--quiet',
          '-c',
          'core.symlinks=true',
          '-c',
          'core.autocrlf=' + autocrlf,
          f.roots.cwd,
          clone,
        ],
        f.temporaryRoot,
      );
      const cloned = { ...f, roots: { ...f.roots, cwd: clone } };
      const paths = getStatePaths(cloned.roots, 'project');
      const before = await readFile(paths.lockPath, 'utf8');
      expect(before).not.toContain(f.roots.cwd);
      const skill = (await installer.list())[0]!.skills[0]!;
      const link = join(clone, copies[1]!);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect((await readlink(link)).replaceAll('\\', '/')).toBe('../../.agents/skills/docs-check');
      for (const dir of copies) {
        expect(await readFile(join(clone, dir, path))).toEqual(binaryResource);
        expect(await hashDirectory(join(clone, copies[0]!))).toBe(skill.contentHash);
      }
      const listed = runCliSync(cloned, ['list']);
      expect(listed.status, listed.stderr).toBe(0);
      expect(listed.stdout).toContain('docs  1.0.0');
      const removed = runCliSync(cloned, ['remove', 'docs', '-y']);
      expect(removed.status, removed.stderr).toBe(0);
      expect(JSON.parse(await readFile(paths.lockPath, 'utf8')).packages).toEqual([]);
      expect(await readFile(getStatePaths(f.roots, 'project').lockPath, 'utf8')).toBe(before);
    });
  },
);
