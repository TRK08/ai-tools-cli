import {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  truncate,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { fileSymlinks, symlink } from '../helpers/links.ts';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hashDirectory } from '@/state/hash';

import { withTestEnvironment } from '../helpers/test-environment.ts';

const io = { lstat, readdir, readlink, open };

describe('portable content hash', () => {
  it.skipIf(process.platform === 'win32')(
    'preserves raw POSIX bytes through modeled path operations on any POSIX filesystem',
    async () => {
      await withTestEnvironment(async (f) => {
        const backing = join(f.roots.home, 'backing');
        await writeFile(backing, 'bytes');
        let name = Buffer.from([0xff]);
        const fs = {
          ...io,
          readdir: vi.fn().mockImplementation(async () => [name]),
          lstat: ((path, options) =>
            lstat(
              Buffer.from(path as Buffer).equals(Buffer.from(f.roots.cwd)) ? f.roots.cwd : backing,
              options,
            )) as typeof lstat,
          open: async (...args: Parameters<typeof open>) => {
            expect(args[0]).toEqual(Buffer.concat([Buffer.from(f.roots.cwd + '/'), name]));
            return open(backing, args[1], args[2]);
          },
        };
        await expect(hashDirectory(f.roots.cwd, { fileSystem: fs })).rejects.toThrow(
          'Непереносимое',
        );
        const first = await hashDirectory(f.roots.cwd, { portableNames: false, fileSystem: fs });
        name = Buffer.from([0xfe]);
        expect(await hashDirectory(f.roots.cwd, { portableNames: false, fileSystem: fs })).not.toBe(
          first,
        );
      });
    },
  );

  it('matches the framed Unicode/binary reference independently of the physical root', async () => {
    await withTestEnvironment(async (f) => {
      await mkdir(join(f.roots.cwd, 'nested'));
      await mkdir(join(f.roots.cwd, 'empty', 'child'), { recursive: true });
      await writeFile(join(f.roots.cwd, 'nested', 'é.bin'), Buffer.from([0, 255, 10, 13]));
      expect(await hashDirectory(f.roots.cwd)).toBe(
        '7863f863fd17f04eae95394f7c738cc19cd0a8d9eb59c410fe8c1bbe0b9b71bf',
      );
    });
  });

  it('changes for LF/CRLF and for a nonempty directory moved to a different logical name', async () => {
    await withTestEnvironment(async (f) => {
      const nested = join(f.roots.cwd, 'nested');
      await mkdir(nested);
      await writeFile(join(nested, 'text'), 'first\nsecond\n');
      const lf = await hashDirectory(f.roots.cwd);
      await writeFile(join(nested, 'text'), 'first\r\nsecond\r\n');
      expect(await hashDirectory(f.roots.cwd)).not.toBe(lf);
      await writeFile(join(nested, 'text'), 'first\nsecond\n');
      await rename(nested, join(f.roots.cwd, 'renamed'));
      expect(await hashDirectory(f.roots.cwd)).not.toBe(lf);
    });
  });

  it.skipIf(process.platform !== 'linux')(
    'keeps native POSIX byte names without lossy decoding and requires the explicit mode',
    async () => {
      await withTestEnvironment(async (f) => {
        const path = Buffer.concat([Buffer.from(f.roots.cwd + '/'), Buffer.from([0xff, 0xfe])]);
        await writeFile(path, 'raw bytes');
        await expect(hashDirectory(f.roots.cwd)).rejects.toMatchObject({ code: 'INVALID_PATH' });
        const original = await hashDirectory(f.roots.cwd, { portableNames: false });
        await rename(
          path,
          Buffer.concat([Buffer.from(f.roots.cwd + '/'), Buffer.from([0xff, 0xfd])]),
        );
        expect(await hashDirectory(f.roots.cwd, { portableNames: false })).not.toBe(original);
      });
    },
  );

  it.each(['A/a', 'NFC/NFD'] as const)(
    'rejects %s collisions before opening a leaf',
    async (kind) => {
      await withTestEnvironment(async (f) => {
        const openSpy = vi.fn(open);
        const names = kind === 'A/a' ? ['A', 'a'] : ['é', 'e\u0301'];
        await expect(
          hashDirectory(f.roots.cwd, {
            fileSystem: {
              ...io,
              readdir: vi.fn().mockResolvedValue(names.map((name) => Buffer.from(name))),
              open: openSpy,
            },
          }),
        ).rejects.toThrow('Коллизия');
        expect(openSpy).not.toHaveBeenCalled();
      });
    },
  );

  it.each(['grow', 'truncate', 'replace'] as const)(
    'rejects a file that changes during reading: %s',
    async (change) => {
      await withTestEnvironment(async (f) => {
        const path = join(f.roots.cwd, 'large');
        await writeFile(path, Buffer.alloc(150_000, 0x61));
        let handle: FileHandle | undefined;
        const fs = {
          ...io,
          open: async (...args: Parameters<typeof open>) => {
            handle = await open(...args);
            if (change === 'replace') {
              await rename(path, join(f.roots.home, 'saved'));
              await writeFile(path, 'replacement');
            } else {
              const read = handle.read.bind(handle);
              let changed = false;
              vi.spyOn(handle, 'read').mockImplementation(
                async (...args: Parameters<typeof read>) => {
                  const result = await read(...args);
                  if (!changed) {
                    changed = true;
                    if (change === 'truncate') await truncate(path, 10);
                    else await writeFile(path, Buffer.alloc(200_000, 0x61));
                  }
                  return result;
                },
              );
            }
            return handle;
          },
        };
        await expect(hashDirectory(f.roots.cwd, { fileSystem: fs })).rejects.toThrow(/изменился/);
        expect(handle?.fd).toBe(-1);
      });
    },
  );

  it.skipIf(!fileSymlinks)(
    'rejects a link to the same opened inode installed during open',
    async () => {
      await withTestEnvironment(async (f) => {
        const path = join(f.roots.cwd, 'file'),
          saved = join(f.roots.home, 'saved');
        await writeFile(path, 'bytes');
        let handle: FileHandle | undefined;
        const read = vi.fn();
        await expect(
          hashDirectory(f.roots.cwd, {
            fileSystem: {
              ...io,
              open: async (...args) => {
                handle = await open(...args);
                vi.spyOn(handle, 'read').mockImplementation(read);
                await rename(path, saved);
                await symlink(saved, path);
                return handle;
              },
            },
          }),
        ).rejects.toThrow(/изменился/);
        expect(handle?.fd).toBe(-1);
        expect(read).not.toHaveBeenCalled();
      });
    },
  );

  it('preserves abort and close failure together without returning a digest', async () => {
    await withTestEnvironment(async (f) => {
      await writeFile(join(f.roots.cwd, 'file'), Buffer.alloc(150_000));
      const controller = new AbortController();
      const reason = new Error('abort hash'),
        closeError = new Error('close failed');
      let handle: FileHandle | undefined;
      await expect(
        hashDirectory(f.roots.cwd, {
          signal: controller.signal,
          fileSystem: {
            ...io,
            open: async (...args) => {
              handle = await open(...args);
              const read = handle.read.bind(handle),
                close = handle.close.bind(handle);
              vi.spyOn(handle, 'read').mockImplementation(
                async (...args: Parameters<typeof read>) => {
                  const result = await read(...args);
                  controller.abort(reason);
                  return result;
                },
              );
              vi.spyOn(handle, 'close').mockImplementation(async () => {
                await close();
                throw closeError;
              });
              return handle;
            },
          },
        }),
      ).rejects.toMatchObject({ errors: [reason, closeError] });
      expect(handle?.fd).toBe(-1);
    });
  });
});
