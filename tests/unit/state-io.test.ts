import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { fileSymlinks, symlink } from '../helpers/links.ts';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { getStatePaths } from '../../src/state/paths.ts';
import { StateStore, defaultStateFileIO } from '../../src/state/store.ts';
import { createEmptyLock } from '../../src/state/types.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

describe('verified state reads and atomic writes', () => {
  it('keeps the original write error and the path when temporary cleanup fails', async () => {
    await withTestEnvironment(async (f) => {
      const paths = getStatePaths(f.roots, 'project');
      await new StateStore(paths).write(createEmptyLock());
      const previous = await readFile(paths.lockPath);
      const failure = new Error('temporary write failed');
      let recovery = '';
      const store = new StateStore(paths, {
        ...defaultStateFileIO,
        writeTemporaryFile: async (path) => {
          recovery = path;
          await mkdir(path);
          await writeFile(join(path, 'leftover'), 'recovery');
          throw failure;
        },
      });
      await expect(store.write(createEmptyLock())).rejects.toMatchObject({
        errors: [failure, expect.any(Error)],
        message: expect.stringContaining('.skills-installer-lock-'),
      });
      expect(await readFile(paths.lockPath)).toEqual(previous);
      expect(await readFile(join(recovery, 'leftover'), 'utf8')).toBe('recovery');
      await expect(access(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it.for(['file', 'symlink', 'missing'] as const)(
    'refuses a %s replacement during open without returning empty state',
    async (replacement, context) => {
      if (replacement === 'symlink' && !fileSymlinks)
        context.skip('Файловый symlink недоступен; modeled I/O проверяется отдельно.');
      await withTestEnvironment(async (f) => {
        const paths = getStatePaths(f.roots, 'project');
        await new StateStore(paths).write(createEmptyLock());
        let handle: FileHandle | undefined;
        const read = vi.fn();
        const store = new StateStore(paths, {
          ...defaultStateFileIO,
          open: async (...args) => {
            handle = await open(...args);
            vi.spyOn(handle, 'readFile').mockImplementation(read);
            const saved = join(f.roots.cwd, 'saved-lock');
            await rename(paths.lockPath, saved);
            if (replacement === 'file')
              await writeFile(paths.lockPath, JSON.stringify(createEmptyLock()));
            if (replacement === 'symlink') await symlink(saved, paths.lockPath);
            return handle;
          },
        });
        await expect(store.read()).rejects.toMatchObject({ code: 'INVALID_LOCK' });
        expect(handle?.fd).toBe(-1);
        expect(read).not.toHaveBeenCalled();
      });
    },
  );

  it.each(['directory', 'special'] as const)('rejects a %s lock before open', async (kind) => {
    await withTestEnvironment(async (f) => {
      const paths = getStatePaths(f.roots, 'project');
      await new StateStore(paths).write(createEmptyLock());
      const before = await lstat(paths.lockPath, { bigint: true });
      const openSpy = vi.fn(open);
      const store = new StateStore(paths, {
        ...defaultStateFileIO,
        lstat: async () =>
          Object.assign(Object.create(before), {
            isFile: () => false,
            isDirectory: () => kind === 'directory',
          }),
        open: openSpy,
      });
      await expect(store.read()).rejects.toMatchObject({ code: 'INVALID_LOCK' });
      expect(openSpy).not.toHaveBeenCalled();
    });
  });

  it('preserves malformed JSON and close failures together', async () => {
    await withTestEnvironment(async (f) => {
      const paths = getStatePaths(f.roots, 'project');
      await writeFile(paths.lockPath, '{broken');
      const closeError = new Error('close failed');
      let handle: FileHandle | undefined;
      const store = new StateStore(paths, {
        ...defaultStateFileIO,
        open: async (...args) => {
          handle = await open(...args);
          const close = handle.close.bind(handle);
          vi.spyOn(handle, 'close').mockImplementation(async () => {
            await close();
            throw closeError;
          });
          return handle;
        },
      });
      await expect(store.read()).rejects.toMatchObject({
        errors: [expect.objectContaining({ code: 'INVALID_LOCK' }), closeError],
      });
      expect(handle?.fd).toBe(-1);
    });
  });

  it.each(['sync', 'close'] as const)(
    'preserves the previous lock and cleans temp on %s failure',
    async (stage) => {
      await withTestEnvironment(async (f) => {
        const paths = getStatePaths(f.roots, 'project');
        const store = new StateStore(paths);
        await store.write(createEmptyLock());
        const previous = await readFile(paths.lockPath);
        const failure = new Error(stage + ' failed');
        const writing = new StateStore(paths, {
          ...defaultStateFileIO,
          open: async (...args) => {
            const handle = await open(...args);
            if (args[1] === 'wx') {
              if (stage === 'sync') vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
              else {
                const close = handle.close.bind(handle);
                vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
                  await close();
                  throw failure;
                });
              }
            }
            return handle;
          },
        });
        await expect(writing.write(createEmptyLock())).rejects.toBe(failure);
        expect(await readFile(paths.lockPath)).toEqual(previous);
        expect(
          (await readdir(paths.root)).filter((name) => name.startsWith('.skills-installer-lock-')),
        ).toEqual([]);
        await expect(access(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      });
    },
  );
});
