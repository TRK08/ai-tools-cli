import { access, readFile } from 'node:fs/promises';
import { symlink } from '../helpers/links.ts';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getSkillDirectory, getStatePaths } from '@/state/paths';
import { StateStore } from '@/state/store';
import { createEmptyLock } from '@/state/types';
import { withTestEnvironment } from '../helpers/test-environment.ts';

describe('state paths and portable schema', () => {
  it('rejects project scope in home before creating state, while global scope remains usable', async () => {
    await withTestEnvironment(async (fixture) => {
      const roots = { ...fixture.roots, cwd: fixture.roots.home };
      expect(() => getStatePaths(roots, 'project')).toThrowError(
        expect.objectContaining({
          code: 'PROJECT_IN_HOME',
          message: expect.stringContaining('--global'),
        }),
      );
      const global = new StateStore(getStatePaths(roots, 'global'));
      await expect(access(global.paths.root)).rejects.toMatchObject({ code: 'ENOENT' });
      await global.write(createEmptyLock());
      expect(await global.read()).toEqual(createEmptyLock());
    });
  });

  it('rejects a lexically equivalent home path after normalization', async () => {
    await withTestEnvironment(async (fixture) => {
      const roots = { ...fixture.roots, cwd: `${fixture.roots.home}/child/..` };
      expect(() => getStatePaths(roots, 'project')).toThrowError(
        expect.objectContaining({ code: 'PROJECT_IN_HOME' }),
      );
    });
  });

  it('rejects project reads/writes through a home symlink without creating or changing global state', async () => {
    await withTestEnvironment(async (fixture) => {
      const alias = join(fixture.temporaryRoot, 'home-alias');
      await symlink(fixture.roots.home, alias);
      const project = new StateStore(getStatePaths({ ...fixture.roots, cwd: alias }, 'project'));
      const global = new StateStore(getStatePaths(fixture.roots, 'global'));
      await expect(project.read()).rejects.toMatchObject({ code: 'PROJECT_IN_HOME' });
      await expect(project.write(createEmptyLock())).rejects.toMatchObject({
        code: 'PROJECT_IN_HOME',
      });
      await expect(access(global.paths.root)).rejects.toMatchObject({ code: 'ENOENT' });
      await global.write(createEmptyLock());
      const before = await readFile(global.paths.lockPath, 'utf8');
      await expect(project.read()).rejects.toMatchObject({ code: 'PROJECT_IN_HOME' });
      await expect(project.write(createEmptyLock())).rejects.toMatchObject({
        code: 'PROJECT_IN_HOME',
      });
      expect(await readFile(global.paths.lockPath, 'utf8')).toBe(before);
      expect(await global.read()).toEqual(createEmptyLock());
      await expect(access(global.paths.operationLockPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('uses exact cwd, including nested projects, and independent home without Git discovery', async () => {
    await withTestEnvironment(async (fixture) => {
      const roots = { ...fixture.roots, cwd: join(fixture.roots.cwd, 'packages', 'nested') };
      const project = getStatePaths(roots, 'project');
      const global = getStatePaths(roots, 'global');
      expect(project.root).toBe(roots.cwd);
      expect(project.skillsDirectory).toBe(join(roots.cwd, '.agents', 'skills'));
      expect(project.lockPath).toBe(join(roots.cwd, 'skills-installer-lock.json'));
      expect(global.root).toBe(join(roots.home, '.agents'));
      expect(global.lockPath).toBe(join(roots.home, '.agents', 'skills-installer-lock.json'));
      expect(project.lockPath).not.toBe(global.lockPath);
      expect(getSkillDirectory(project, 'demo')).toBe(join(project.skillsDirectory, 'demo'));
      expect(() => getStatePaths({ ...roots, cwd: 'relative' }, 'project')).toThrow();
      for (const name of ['..', '.', '../outside', '/absolute', 'bad\\name', 'bad\0name', '']) {
        expect(() => getSkillDirectory(project, name)).toThrow();
      }
    });
  });
});
