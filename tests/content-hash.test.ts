import { execFileSync } from 'node:child_process';
import { chmod, mkdir, rename, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { hashDirectory } from '../src/state/hash.ts';
import { withTestEnvironment } from './helpers/test-environment.js';

describe('content hash', () => {
  it('requires an explicit absolute root without falling back to the process cwd', async () => {
    await expect(hashDirectory('.')).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('includes bytes across multiple streaming chunks', async () => {
    await withTestEnvironment(async ({ roots }) => {
      const file = join(roots.cwd, 'large-resource');
      const bytes = Buffer.alloc(150_000, 0x5a);
      await writeFile(file, bytes);
      const original = await hashDirectory(roots.cwd);
      bytes[140_000] = 0x5b;
      await writeFile(file, bytes);
      expect(await hashDirectory(roots.cwd)).not.toBe(original);
    });
  });

  it('returns a stable lowercase SHA-256 and notices changes to binary bytes', async () => {
    await withTestEnvironment(async ({ roots }) => {
      const file = join(roots.cwd, 'binary');
      await writeFile(file, Buffer.from([0, 255, 128, 10, 0]));
      const original = await hashDirectory(roots.cwd);

      expect(original).toMatch(/^[a-f0-9]{64}$/);
      expect(await hashDirectory(roots.cwd)).toBe(original);

      await writeFile(file, Buffer.from([0, 255, 129, 10, 0]));
      expect(await hashDirectory(roots.cwd)).not.toBe(original);
    });
  });

  it('notices addition, deletion and renaming of files', async () => {
    await withTestEnvironment(async ({ roots }) => {
      await writeFile(join(roots.cwd, 'original'), 'unchanged');
      const original = await hashDirectory(roots.cwd);
      const added = join(roots.cwd, 'added');

      await writeFile(added, 'new');
      const withAddition = await hashDirectory(roots.cwd);
      expect(withAddition).not.toBe(original);

      await unlink(added);
      expect(await hashDirectory(roots.cwd)).toBe(original);

      await rename(join(roots.cwd, 'original'), join(roots.cwd, 'renamed'));
      expect(await hashDirectory(roots.cwd)).not.toBe(original);

      await rename(join(roots.cwd, 'renamed'), join(roots.cwd, 'original'));
      expect(await hashDirectory(roots.cwd)).toBe(original);
    });
  });

  it('includes hidden files, lock files and files inside node_modules', async () => {
    await withTestEnvironment(async ({ roots }) => {
      await mkdir(join(roots.cwd, 'node_modules'));
      const original = await hashDirectory(roots.cwd);

      for (const name of ['.hidden', 'lock.json', 'node_modules/resource']) {
        const file = join(roots.cwd, name);
        await writeFile(file, 'included');
        expect(await hashDirectory(roots.cwd)).not.toBe(original);
        await unlink(file);
        expect(await hashDirectory(roots.cwd)).toBe(original);
      }
    });
  });

  it('preserves the hash across absolute roots and file creation order', async () => {
    await withTestEnvironment(async ({ roots }) => {
      const first = join(roots.cwd, 'first');
      const second = join(roots.cwd, 'second');
      await mkdir(first);
      await mkdir(second);

      const names = ['z', 'A', 'ä', 'file with spaces'];
      for (const [directory, order] of [
        [first, names],
        [second, names.toReversed()],
      ] as const) {
        await mkdir(join(directory, 'empty'));
        await mkdir(join(directory, 'nested'));
        for (const name of order) {
          await writeFile(join(directory, name), Buffer.from([0, 128, 255]));
        }
        await writeFile(join(directory, 'nested', 'script'), '#!/bin/sh\n');
        await chmod(join(directory, 'nested', 'script'), 0o744);
      }

      expect(await hashDirectory(first)).toBe(await hashDirectory(second));
    });
  });

  it('ignores executable and individual permission bits', async () => {
    await withTestEnvironment(async ({ roots }) => {
      const script = join(roots.cwd, 'script');
      await writeFile(script, 'same bytes');
      await chmod(script, 0o644);
      const nonExecutable = await hashDirectory(roots.cwd);

      await chmod(script, 0o600);
      expect(await hashDirectory(roots.cwd)).toBe(nonExecutable);

      await chmod(script, 0o700);
      const executable = await hashDirectory(roots.cwd);
      expect(executable).toBe(nonExecutable);

      await chmod(script, 0o601);
      expect(await hashDirectory(roots.cwd)).toBe(executable);

      await chmod(script, 0o600);
      expect(await hashDirectory(roots.cwd)).toBe(nonExecutable);
    });
  });

  it('ignores modification times and directory permissions', async () => {
    await withTestEnvironment(async ({ roots }) => {
      const nested = join(roots.cwd, 'nested');
      const file = join(nested, 'file');
      await mkdir(nested);
      await writeFile(file, 'unchanged');
      const original = await hashDirectory(roots.cwd);

      const timestamp = new Date('2001-01-01T00:00:00Z');
      await utimes(file, timestamp, timestamp);
      await utimes(nested, timestamp, timestamp);
      await utimes(roots.cwd, timestamp, timestamp);
      await chmod(nested, 0o700);
      expect(await hashDirectory(roots.cwd)).toBe(original);
    });
  });

  it('includes empty files but ignores trees consisting only of directories', async () => {
    await withTestEnvironment(async ({ roots }) => {
      const empty = await hashDirectory(roots.cwd);
      const entry = join(roots.cwd, 'entry');
      await writeFile(entry, '');
      const withFile = await hashDirectory(roots.cwd);
      expect(withFile).not.toBe(empty);

      await unlink(entry);
      await mkdir(entry);
      const withDirectory = await hashDirectory(roots.cwd);
      expect(withDirectory).toBe(empty);
      expect(withDirectory).not.toBe(withFile);

      await mkdir(join(entry, 'nested'));
      expect(await hashDirectory(roots.cwd)).toBe(withDirectory);

      await rm(entry, { recursive: true });
      expect(await hashDirectory(roots.cwd)).toBe(empty);
    });
  });

  it('keeps file boundaries distinct even when concatenated contents are identical', async () => {
    await withTestEnvironment(async ({ roots }) => {
      const first = join(roots.cwd, 'first');
      const second = join(roots.cwd, 'second');
      await mkdir(first);
      await mkdir(second);
      await writeFile(join(first, 'a'), 'x');
      await writeFile(join(first, 'b'), 'yz');
      await writeFile(join(second, 'a'), 'xy');
      await writeFile(join(second, 'b'), 'z');

      expect(await hashDirectory(first)).not.toBe(await hashDirectory(second));
    });
  });

  it('distinguishes an internal symlink from a file with identical contents', async () => {
    await withTestEnvironment(async ({ roots }) => {
      await writeFile(join(roots.cwd, 'target'), 'same bytes');
      const link = join(roots.cwd, 'entry');
      await writeFile(link, 'same bytes');
      const withFile = await hashDirectory(roots.cwd);

      await unlink(link);
      await symlink('target', link);
      expect(await hashDirectory(roots.cwd)).not.toBe(withFile);
    });
  });

  it('notices changes to internal link targets even when their contents are identical', async () => {
    await withTestEnvironment(async ({ roots }) => {
      await writeFile(join(roots.cwd, 'first'), 'same bytes');
      await writeFile(join(roots.cwd, 'second'), 'same bytes');
      const link = join(roots.cwd, 'entry');
      await symlink('first', link);
      const original = await hashDirectory(roots.cwd);

      await unlink(link);
      await symlink('second', link);
      expect(await hashDirectory(roots.cwd)).not.toBe(original);
    });
  });

  it('hashes an external link target text without reading the target contents', async () => {
    await withTestEnvironment(async ({ roots }) => {
      const target = join(roots.home, 'external-target');
      const alternative = join(roots.home, 'alternative-target');
      await writeFile(target, 'outside the hashed tree');
      await writeFile(alternative, 'different outside contents');
      const link = join(roots.cwd, 'entry');
      await symlink(target, link);
      const original = await hashDirectory(roots.cwd);

      await writeFile(target, 'modified outside contents');
      expect(await hashDirectory(roots.cwd)).toBe(original);
      await unlink(target);
      expect(await hashDirectory(roots.cwd)).toBe(original);

      await unlink(link);
      await symlink(alternative, link);
      expect(await hashDirectory(roots.cwd)).not.toBe(original);
    });
  });

  it('handles broken links, self-links and link cycles without following them', async () => {
    await withTestEnvironment(async ({ roots }) => {
      await symlink('missing', join(roots.cwd, 'broken'));
      await symlink('self', join(roots.cwd, 'self'));
      await symlink('cycle-b', join(roots.cwd, 'cycle-a'));
      await symlink('cycle-a', join(roots.cwd, 'cycle-b'));
      const original = await hashDirectory(roots.cwd);

      expect(original).toMatch(/^[a-f0-9]{64}$/);
      expect(await hashDirectory(roots.cwd)).toBe(original);

      await unlink(join(roots.cwd, 'broken'));
      await symlink('different-missing', join(roots.cwd, 'broken'));
      expect(await hashDirectory(roots.cwd)).not.toBe(original);
    });
  });

  it('distinguishes a root symlink from its directory without traversing the root link', async () => {
    await withTestEnvironment(async ({ roots }) => {
      const directory = join(roots.cwd, 'directory');
      const link = join(roots.cwd, 'link');
      await mkdir(directory);
      const file = join(directory, 'file');
      await writeFile(file, 'original');
      await symlink('directory', link);
      const linked = await hashDirectory(link);

      expect(linked).not.toBe(await hashDirectory(directory));
      await writeFile(file, 'changed');
      expect(await hashDirectory(link)).toBe(linked);
      await rm(directory, { recursive: true });
      expect(await hashDirectory(link)).toBe(linked);
    });
  });

  it.skipIf(process.platform === 'win32')(
    'fails closed on a FIFO instead of reading or blocking on it',
    async () => {
      await withTestEnvironment(async (fixture) => {
        const fifo = join(fixture.roots.cwd, 'fifo');
        execFileSync('mkfifo', [fifo], {
          cwd: fixture.roots.cwd,
          env: fixture.env,
          timeout: 5_000,
        });

        await expect(hashDirectory(fixture.roots.cwd)).rejects.toThrow(
          'Неподдерживаемый объект файловой системы',
        );
      });
    },
  );

  it('reports a missing root instead of hashing it as an empty directory', async () => {
    await withTestEnvironment(async ({ roots }) => {
      await expect(hashDirectory(join(roots.cwd, 'missing'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });
});
