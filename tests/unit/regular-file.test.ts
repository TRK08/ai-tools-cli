import { constants } from 'node:fs';
import { lstat, open, readFile, rm, writeFile } from 'node:fs/promises';
import { fileSymlinks, symlink } from '../helpers/links.ts';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRegularFileReader } from '../../src/regular-file.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

const io = { lstat: (path: string | Buffer) => lstat(path, { bigint: true }), open };

describe.each(['linux', 'win32'] as const)('regular-file reader with %s flags', (platform) => {
  const read = createRegularFileReader(platform);

  it.each([false, true])('returns a verified handle for a Buffer path: %s', async (buffer) => {
    await withTestEnvironment(async (f) => {
      const path = join(f.roots.cwd, 'ресурс с пробелами');
      await writeFile(path, 'bytes');
      const openSpy = vi.fn(open);
      const { handle, stats } = await read(buffer ? Buffer.from(path) : path, {
        fileSystem: { ...io, open: openSpy },
      });
      try {
        expect(stats.ino).toBe((await io.lstat(path)).ino);
        expect(typeof stats.size).toBe('bigint');
        expect(await handle.readFile('utf8')).toBe('bytes');
        expect(openSpy.mock.calls[0]?.[1]).toBe(
          platform === 'win32'
            ? 'r'
            : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } finally {
        await handle.close();
      }
    });
  });

  it.skipIf(!fileSymlinks)('refuses a symlink before opening it', async () => {
    await withTestEnvironment(async (f) => {
      const target = join(f.roots.cwd, 'target'),
        alias = join(f.roots.cwd, 'alias');
      await writeFile(target, 'bytes');
      await symlink(target, alias);
      const openSpy = vi.fn(open);
      await expect(read(alias, { fileSystem: { ...io, open: openSpy } })).rejects.toThrow(
        'обычный файл',
      );
      expect(openSpy).not.toHaveBeenCalled();
    });
  });

  it.skipIf(!fileSymlinks)(
    'rejects a symlink to the same inode installed after open and closes without reading',
    async () => {
      await withTestEnvironment(async (f) => {
        const path = join(f.roots.cwd, 'resource'),
          target = join(f.roots.cwd, 'saved');
        await writeFile(path, 'original');
        // Keep the opened inode alive through another hard link: post-open lstat must reject a symlink.
        const { link } = await import('node:fs/promises');
        await link(path, target);
        let closed = false;
        const fs = {
          ...io,
          open: async (...args: Parameters<typeof open>) => {
            const handle = await open(...args),
              close = handle.close.bind(handle);
            vi.spyOn(handle, 'close').mockImplementation(async () => {
              closed = true;
              await close();
            });
            vi.spyOn(handle, 'read').mockImplementation(async () => {
              throw new Error('must not read');
            });
            await rm(path);
            await symlink(target, path);
            return handle;
          },
        };
        await expect(read(path, { fileSystem: fs })).rejects.toThrow('изменился');
        expect(closed).toBe(true);
        expect(await readFile(target, 'utf8')).toBe('original');
      });
    },
  );

  it('closes after fstat cancellation and preserves a close failure with its cause', async () => {
    await withTestEnvironment(async (f) => {
      const path = join(f.roots.cwd, 'resource');
      await writeFile(path, 'original');
      const controller = new AbortController(),
        reason = new Error('cancel'),
        closeError = new Error('close failed');
      const fs = {
        ...io,
        open: async (...args: Parameters<typeof open>) => {
          const handle = await open(...args),
            close = handle.close.bind(handle),
            stat = handle.stat.bind(handle);
          vi.spyOn(handle, 'stat').mockImplementation(async () => {
            const result = await stat({ bigint: true });
            controller.abort(reason);
            return result;
          });
          vi.spyOn(handle, 'close').mockImplementation(async () => {
            await close();
            throw closeError;
          });
          return handle;
        },
      };
      await expect(read(path, { fileSystem: fs, signal: controller.signal })).rejects.toMatchObject(
        { errors: [reason, closeError] },
      );
    });
  });

  it('rejects a different expected inode before open', async () => {
    await withTestEnvironment(async (f) => {
      const path = join(f.roots.cwd, 'resource'),
        other = join(f.roots.cwd, 'other');
      await writeFile(path, 'bytes');
      await writeFile(other, 'different');
      const openSpy = vi.fn(open);
      await expect(
        read(path, { expected: await io.lstat(other), fileSystem: { ...io, open: openSpy } }),
      ).rejects.toThrow('неизменённый');
      expect(openSpy).not.toHaveBeenCalled();
    });
  });

  it.each(['fifo'])('rejects a modeled %s before open on every host', async (kind) => {
    await withTestEnvironment(async (f) => {
      const path = join(f.roots.cwd, 'modeled');
      await writeFile(path, 'unchanged');
      const stats = await io.lstat(path);
      const openSpy = vi.fn(open);
      await expect(
        read(path, {
          fileSystem: {
            open: openSpy,
            lstat: async () =>
              Object.assign(Object.create(stats), {
                isFile: () => false,
                isSymbolicLink: () => kind === 'symlink',
                isFIFO: () => kind === 'fifo',
                isDirectory: () => kind === 'directory',
              }),
          },
        }),
      ).rejects.toThrow('обычный файл');
      expect(openSpy).not.toHaveBeenCalled();
    });
  });

  it('rejects a modeled post-open symlink with the same inode and closes its handle', async () => {
    await withTestEnvironment(async (f) => {
      const path = join(f.roots.cwd, 'modeled');
      await writeFile(path, 'unchanged');
      const stats = await io.lstat(path);
      let opened = false;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      await expect(
        read(path, {
          fileSystem: {
            open: async (...args) => {
              handle = await open(...args);
              opened = true;
              return handle;
            },
            lstat: async () =>
              opened
                ? Object.assign(Object.create(stats), {
                    isFile: () => false,
                    isSymbolicLink: () => true,
                  })
                : stats,
          },
        }),
      ).rejects.toThrow('изменился');
      expect(handle?.fd).toBe(-1);
    });
  });
});
