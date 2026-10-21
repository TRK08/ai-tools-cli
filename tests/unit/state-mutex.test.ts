import type { BigIntStats } from 'node:fs';
import {
  access,
  lstat,
  open,
  readFile,
  rename,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';

import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withScopeLock, scopeLockFileSystem } from '../../src/state/mutex.ts';
import { getStatePaths } from '../../src/state/paths.ts';

import { withTestEnvironment } from '../helpers/test-environment.ts';

describe('scope lock ownership and failures', () => {
  it('keeps a foreign replacement and closes its own handle', async () => {
    await withTestEnvironment(async (f) => {
      const paths = getStatePaths(f.roots, 'project');
      let owner: FileHandle | undefined;
      const fs = {
        ...scopeLockFileSystem,
        open: async (...args: Parameters<typeof open>) => (owner = await open(...args)),
      };
      const failure = new Error('callback failed');
      await expect(
        withScopeLock(
          paths,
          async () => {
            await rename(paths.operationLockPath, join(f.roots.cwd, 'previous-lock'));
            await writeFile(paths.operationLockPath, 'another owner');
            throw failure;
          },
          fs,
        ),
      ).rejects.toBe(failure);
      expect(owner?.fd).toBe(-1);
      expect(await readFile(paths.operationLockPath, 'utf8')).toBe('another owner');
    });
  });

  it('compares IDs beyond Number precision as BigInt', async () => {
    await withTestEnvironment(async (f) => {
      const paths = getStatePaths(f.roots, 'project');
      const ino = 2n ** 60n;
      const unlink = vi.fn(scopeLockFileSystem.unlink);
      const fs = {
        ...scopeLockFileSystem,
        open: async (...args: Parameters<typeof open>) => {
          const handle = await open(...args);
          const stats = await handle.stat({ bigint: true });
          vi.spyOn(handle, 'stat').mockImplementation(async (options) => {
            expect(options).toEqual({ bigint: true });
            return Object.assign(Object.create(stats), { ino }) as BigIntStats;
          });
          return handle;
        },
        lstat: async (path: string) =>
          Object.assign(Object.create(await lstat(path, { bigint: true })), {
            ino: ino + 1n,
          }) as BigIntStats,
        unlink,
      };
      await withScopeLock(paths, async () => undefined, fs);
      expect(unlink).not.toHaveBeenCalled();
      await expect(access(paths.operationLockPath)).resolves.toBeUndefined();
    });
  });

  it.each(['write', 'lstat', 'unlink', 'close'] as const)(
    'closes resources on %s failure and preserves the first error',
    async (stage) => {
      await withTestEnvironment(async (f) => {
        const paths = getStatePaths(f.roots, 'project');
        const first = new Error('operation failed');
        const failure = new Error(stage + ' failed');
        let handle: FileHandle | undefined;
        const fs = {
          ...scopeLockFileSystem,
          open: async (...args: Parameters<typeof open>) => {
            handle = await open(...args);
            if (stage === 'write') vi.spyOn(handle, 'writeFile').mockRejectedValue(failure);
            if (stage === 'close') {
              const close = handle.close.bind(handle);
              vi.spyOn(handle, 'close').mockImplementation(async () => {
                await close();
                throw failure;
              });
            }
            return handle;
          },
          ...(stage === 'lstat'
            ? {
                lstat: async () => {
                  throw failure;
                },
              }
            : {}),
          ...(stage === 'unlink'
            ? {
                unlink: async () => {
                  throw failure;
                },
              }
            : {}),
        };
        const run = vi.fn(async () => {
          throw first;
        });
        const pending = withScopeLock(paths, run, fs);
        if (stage === 'write') {
          await expect(pending).rejects.toBe(failure);
          expect(run).not.toHaveBeenCalled();
        } else await expect(pending).rejects.toMatchObject({ errors: [first, failure] });
        expect(handle?.fd).toBe(-1);
        if (stage === 'lstat' || stage === 'unlink')
          await expect(access(paths.operationLockPath)).resolves.toBeUndefined();
        else
          await expect(access(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      });
    },
  );

  it('retains a lock of unknown ownership when fstat and close both fail', async () => {
    await withTestEnvironment(async (f) => {
      const paths = getStatePaths(f.roots, 'project');
      const first = new Error('fstat failed'),
        second = new Error('close failed');
      let handle: FileHandle | undefined;
      const unlink = vi.fn(scopeLockFileSystem.unlink);
      await expect(
        withScopeLock(paths, async () => undefined, {
          ...scopeLockFileSystem,
          unlink,
          open: async (...args) => {
            handle = await open(...args);
            const close = handle.close.bind(handle);
            vi.spyOn(handle, 'stat').mockRejectedValue(first);
            vi.spyOn(handle, 'close').mockImplementation(async () => {
              await close();
              throw second;
            });
            return handle;
          },
        }),
      ).rejects.toMatchObject({ errors: [first, second] });
      expect(handle?.fd).toBe(-1);
      expect(unlink).not.toHaveBeenCalled();
      await expect(access(paths.operationLockPath)).resolves.toBeUndefined();
    });
  });
});
