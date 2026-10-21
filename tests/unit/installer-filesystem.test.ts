import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileTransaction, installerFileSystem } from '../../src/installer/filesystem.ts';
import { OWNED_WORKSPACE_CLEANUP } from '../../src/sources/filesystem.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

describe('FileTransaction', () => {
  it.each([false, true])(
    'commits or reverses dependent moves in the right order: rollback=%s',
    async (rollback) => {
      await withTestEnvironment(async (f) => {
        const source = join(f.roots.cwd, 'source'),
          destination = join(f.roots.cwd, 'destination');
        await writeFile(source, 'original');
        const cause = new Error('operation');
        const result = FileTransaction.run(f.roots.home, installerFileSystem, async (files) => {
          const staged = join(files.workspace, 'staged');
          await files.move(source, staged);
          await files.move(staged, destination);
          if (rollback) throw cause;
          return 'committed';
        });
        if (rollback) await expect(result).rejects.toBe(cause);
        else await expect(result).resolves.toBe('committed');
        expect(await readFile(rollback ? source : destination, 'utf8')).toBe('original');
        expect(
          (await readdir(f.roots.home)).filter((name) =>
            name.startsWith('.skills-installer-work-'),
          ),
        ).toEqual([]);
      });
    },
  );
  it('preserves the original on EXDEV without trying copy replacement', async () => {
    await withTestEnvironment(async (f) => {
      const source = join(f.roots.cwd, 'source');
      await writeFile(source, 'keep');
      const cause = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      const cp = vi.fn(installerFileSystem.cp);
      await expect(
        FileTransaction.run(
          f.roots.home,
          {
            ...installerFileSystem,
            cp,
            rename: vi.fn(async () => {
              throw cause;
            }),
          },
          (files) => files.move(source, join(files.workspace, 'staged')),
        ),
      ).rejects.toBe(cause);
      expect(cp).not.toHaveBeenCalled();
      expect(await readFile(source, 'utf8')).toBe('keep');
    });
  });
  it('retains recovery files and both causes after a failed reverse move', async () => {
    await withTestEnvironment(async (f) => {
      const source = join(f.roots.cwd, 'source');
      await writeFile(source, 'keep');
      const cause = new Error('operation'),
        rollback = new Error('rollback');
      const rename = vi
        .fn(installerFileSystem.rename)
        .mockImplementationOnce(installerFileSystem.rename)
        .mockRejectedValueOnce(rollback);
      const rm = vi.fn(installerFileSystem.rm);
      let workspace = '';
      await expect(
        FileTransaction.run(f.roots.home, { ...installerFileSystem, rename, rm }, async (files) => {
          workspace = files.workspace;
          await files.move(source, join(workspace, 'backup'));
          throw cause;
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('восстановления'),
        cause: { errors: [cause, rollback] },
      });
      expect(await readFile(join(workspace, 'backup'), 'utf8')).toBe('keep');
      expect(rm).not.toHaveBeenCalled();
    });
  });
  it.each([false, true])(
    'reports bounded cleanup failure without reversing a committed operation: commit=%s',
    async (commit) => {
      await withTestEnvironment(async (f) => {
        const source = join(f.roots.cwd, 'source'),
          destination = join(f.roots.cwd, 'destination');
        await writeFile(source, 'keep');
        const cause = new Error('operation'),
          cleanup = new Error('cleanup');
        const rm = vi.fn<typeof installerFileSystem.rm>(async () => {
          throw cleanup;
        });
        let workspace = '';
        const result = FileTransaction.run(
          f.roots.home,
          { ...installerFileSystem, rm },
          async (files) => {
            workspace = files.workspace;
            await files.move(source, destination);
            if (!commit) throw cause;
          },
        );
        const error = await result.catch((error) => error);
        expect(error).toMatchObject({
          message: expect.stringContaining(workspace),
          cause: commit ? cleanup : { errors: [cause, cleanup] },
        });
        expect(await readFile(commit ? destination : source, 'utf8')).toBe('keep');
        expect(rm).toHaveBeenCalledExactlyOnceWith(workspace, OWNED_WORKSPACE_CLEANUP);
        await mkdir(join(workspace, 'retained-for-recovery'));
      });
    },
  );
});
