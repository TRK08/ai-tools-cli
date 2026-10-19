import { lstat, mkdir, open, readdir, readlink, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hashDirectory } from '../src/state/hash.ts';
import { withTestEnvironment } from './helpers/test-environment.ts';

vi.mock('../src/state/native-path.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/state/native-path.ts')>();
  const { win32 } = await import('node:path');
  return { ...actual, ...actual.createPathOperations(win32) };
});

describe('Windows hash paths with modeled I/O', () => {
  it.each(['é.bin', 'e\u0301.bin'])(
    'hashes NFC logical paths and opens the actual physical name: %s',
    async (name) => {
      await withTestEnvironment(async (f) => {
        const file = join(f.roots.cwd, 'backing-file');
        await writeFile(file, Buffer.from([0, 255, 10, 13]));
        await mkdir(join(f.roots.cwd, 'backing-directory'));
        const directory = join(f.roots.cwd, 'backing-directory');
        const root = 'C:\\Different Root\\скилл';
        const paths = new Map([
          [root, directory],
          [win32.join(root, 'empty'), directory],
          [win32.join(root, 'nested'), directory],
          [win32.join(root, 'nested', name), file],
        ]);
        const reads: string[] = [];
        const physicalPath = (path: unknown) => {
          const mapped = paths.get(String(path));
          if (!mapped) throw new Error('Unexpected I/O path: ' + String(path));
          return mapped;
        };
        const fs = {
          lstat: ((path, options) => lstat(physicalPath(path), options)) as typeof lstat,
          readdir: (async (path) => {
            physicalPath(path);
            return (
              String(path) === root
                ? ['nested', 'empty']
                : String(path) === win32.join(root, 'nested')
                  ? [name]
                  : []
            ).map((value) => Buffer.from(value));
          }) as typeof readdir,
          readlink,
          open: async (...args: Parameters<typeof open>) => {
            reads.push(String(args[0]));
            return open(physicalPath(args[0]), args[1], args[2]);
          },
        };
        expect(await hashDirectory(root, { fileSystem: fs })).toBe(
          '7863f863fd17f04eae95394f7c738cc19cd0a8d9eb59c410fe8c1bbe0b9b71bf',
        );
        expect(reads).toEqual([win32.join(root, 'nested', name)]);
        // The global/native switch cannot disable actual Windows name restrictions.
        const colliding = {
          ...fs,
          readdir: vi.fn().mockResolvedValue([Buffer.from('A'), Buffer.from('a')]),
        };
        await expect(
          hashDirectory(root, { portableNames: false, fileSystem: colliding }),
        ).rejects.toThrow('Коллизия');
      });
    },
  );
});
