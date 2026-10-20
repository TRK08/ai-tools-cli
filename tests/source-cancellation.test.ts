import { lstat, mkdir, open, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Parser } from 'tar';
import { prepareDirectory } from '../src/sources/directory.ts';
import { prepareArchive } from '../src/sources/archive.ts';
import { prepareLocalSource } from '../src/sources/local.ts';
import { archiveSourceFileSystem, directorySourceFileSystem } from '../src/sources/filesystem.ts';
import { hashDirectory } from '../src/state/hash.ts';
import * as hashing from '../src/state/hash.ts';
import { Installer } from '../src/installer/installer.ts';
import { getStatePaths } from '../src/state/paths.ts';
import { archiveBytes, skillText } from './helpers/archive.ts';
import { withTestEnvironment, type TestEnvironment } from './helpers/test-environment.ts';

async function source(f: TestEnvironment, archive = false) {
  const path = join(f.roots.cwd, archive ? 'demo.tgz' : 'demo');
  if (archive)
    await writeFile(
      path,
      archiveBytes([
        { path: 'SKILL.md', contents: skillText },
        { path: 'large', contents: Buffer.alloc(200_000, 0x61) },
        { path: 'later', contents: 'must not be written after abort' },
      ]),
    );
  else {
    await mkdir(path);
    await writeFile(join(path, 'SKILL.md'), skillText);
    await writeFile(join(path, 'large'), Buffer.alloc(200_000, 0x61));
    await writeFile(join(path, 'later'), 'must not be written after abort');
  }
  return path;
}

describe('cooperative preparation cancellation', () => {
  it.each([false, true])(
    'rejects an already aborted local source (archive=%s) without creating work files',
    async (archive) =>
      withTestEnvironment(async (f) => {
        const path = await source(f, archive);
        const reason = new Error('cancel preparation');
        const options = {
          cwd: f.roots.cwd,
          temporaryDirectory: f.env.TMPDIR!,
          signal: AbortSignal.abort(reason),
        };
        const result = await prepareLocalSource(path, options).then(
          async (value) => {
            await value.cleanup();
            return null;
          },
          (error) => error,
        );
        expect(result).toBe(reason);
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
      }),
  );

  it('stops copying a large file after an in-flight read and closes both handles', async () =>
    withTestEnvironment(async (f) => {
      const path = await source(f);
      const controller = new AbortController(),
        reason = new Error('stop copying');
      const before = await hashDirectory(path);
      let closed = 0,
        reads = 0,
        writesAfterAbort = 0;
      const fs = {
        ...directorySourceFileSystem,
        open: async (...args: Parameters<typeof open>) => {
          const handle = await open(...args);
          const close = handle.close.bind(handle);
          vi.spyOn(handle, 'close').mockImplementation(async () => {
            closed++;
            await close();
          });
          if (basename(String(args[0])) === 'large' && args[1] !== 'wx') {
            const read = handle.read.bind(handle);
            vi.spyOn(handle, 'read').mockImplementation(
              async (...readArgs: Parameters<typeof read>) => {
                reads++;
                const result = await read(...readArgs);
                controller.abort(reason);
                return result;
              },
            );
          }
          if (args[1] === 'wx') {
            const write = handle.write.bind(handle);
            vi.spyOn(handle, 'write').mockImplementation(
              async (...writeArgs: Parameters<typeof write>) => {
                if (controller.signal.aborted) writesAfterAbort++;
                return write(...writeArgs);
              },
            );
          }
          return handle;
        },
      };
      const result = await prepareDirectory(path, {
        cwd: f.roots.cwd,
        temporaryDirectory: f.env.TMPDIR!,
        signal: controller.signal,
        fileSystem: fs,
      }).then(
        async (value) => {
          await value.cleanup();
          return null;
        },
        (error) => error,
      );
      expect(result).toBe(reason);
      expect(reads).toBe(1);
      expect(writesAfterAbort).toBe(0);
      expect(closed).toBe(4); // SKILL.md and the interrupted large file, input/output each.
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
      expect(await hashDirectory(path)).toBe(before);
    }));

  it.each(['read', 'parse', 'write'] as const)(
    'stops archive %s and removes partial output',
    async (stage) =>
      withTestEnvironment(async (f) => {
        const path = await source(f, true),
          controller = new AbortController();
        const reason = new Error('stop archive');
        const before = await readFile(path);
        if (stage === 'parse') {
          const write = Parser.prototype.write;
          vi.spyOn(Parser.prototype, 'write').mockImplementation(function (this: Parser, ...args) {
            const result = write.apply(this, args);
            controller.abort(reason);
            return result;
          });
        }
        const fs = {
          ...archiveSourceFileSystem,
          open: async (...args: Parameters<typeof open>) => {
            const handle = await open(...args);
            if (stage === 'read' && args[1] !== 'wx') {
              const read = handle.read.bind(handle);
              vi.spyOn(handle, 'read').mockImplementation(
                async (...readArgs: Parameters<typeof read>) => {
                  const result = await read(...readArgs);
                  controller.abort(reason);
                  return result;
                },
              );
            }
            if (stage === 'write' && args[1] === 'wx') {
              const write = handle.write.bind(handle);
              vi.spyOn(handle, 'write').mockImplementation(
                async (...writeArgs: Parameters<typeof write>) => {
                  const result = await write(...writeArgs);
                  controller.abort(reason);
                  return result;
                },
              );
            }
            return handle;
          },
        };
        const result = await prepareArchive(path, {
          cwd: f.roots.cwd,
          temporaryDirectory: f.env.TMPDIR!,
          signal: controller.signal,
          fileSystem: fs,
        }).then(
          async (value) => {
            await value.cleanup();
            return null;
          },
          (error) => error,
        );
        expect(result).toBe(reason);
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
        expect(await readFile(path)).toEqual(before);
      }),
  );

  it('cancels streamed hashing after one read and closes its descriptor', async () =>
    withTestEnvironment(async (f) => {
      const path = await source(f),
        controller = new AbortController(),
        reason = new Error('stop hash');
      let reads = 0,
        closed = 0;
      const fs = {
        lstat,
        readdir,
        readlink,
        open: async (...args: Parameters<typeof open>) => {
          const handle = await open(...args);
          if (basename(String(args[0])) === 'large') {
            const read = handle.read.bind(handle),
              close = handle.close.bind(handle);
            vi.spyOn(handle, 'read').mockImplementation(
              async (...readArgs: Parameters<typeof read>) => {
                reads++;
                const result = await read(...readArgs);
                controller.abort(reason);
                return result;
              },
            );
            vi.spyOn(handle, 'close').mockImplementation(async () => {
              closed++;
              await close();
            });
          }
          return handle;
        },
      };
      await expect(hashDirectory(path, { signal: controller.signal, fileSystem: fs })).rejects.toBe(
        reason,
      );
      expect(reads).toBe(1);
      expect(closed).toBe(1);
      await expect(hashDirectory(path, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    }));

  it('preserves cancellation and cleanup errors instead of reporting a clean cancellation', async () =>
    withTestEnvironment(async (f) => {
      let reads = 0;
      const path = await source(f),
        controller = new AbortController(),
        reason = new Error('cancel');
      const cleanupError = new Error('cleanup blocked');
      await expect(
        prepareDirectory(path, {
          cwd: f.roots.cwd,
          temporaryDirectory: f.env.TMPDIR!,
          signal: controller.signal,
          fileSystem: {
            ...directorySourceFileSystem,
            readdir: async (path) => {
              const names = await directorySourceFileSystem.readdir(path);
              if (++reads === 2) controller.abort(reason);
              return names;
            },
            rm: async () => {
              throw cleanupError;
            },
          },
        }),
      ).rejects.toMatchObject({
        code: 'PREPARATION_FAILED',
        cause: expect.objectContaining({ errors: [reason, cleanupError] }),
      });
      expect(await readdir(f.env.TMPDIR!)).toHaveLength(1);
    }));

  it.each([false, true])(
    'preserves the native abort from metadata reading (archive=%s)',
    async (archive) =>
      withTestEnvironment(async (f) => {
        const path = await source(f, archive),
          controller = new AbortController(),
          reason = new Error('metadata cancelled');
        const fs = archive ? archiveSourceFileSystem : directorySourceFileSystem;
        vi.spyOn(fs, 'readFile').mockImplementation(async (path: string, options: unknown) => {
          controller.abort(reason);
          return readFile(path, options as { encoding: 'utf8'; signal: AbortSignal });
        });
        const options = {
          cwd: f.roots.cwd,
          temporaryDirectory: f.env.TMPDIR!,
          signal: controller.signal,
        };
        await expect(
          archive ? prepareArchive(path, options) : prepareDirectory(path, options),
        ).rejects.toBe(reason);
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
      }),
  );

  it.each([false, true])(
    'cleans a prepared snapshot when its hash is cancelled (archive=%s)',
    async (archive) =>
      withTestEnvironment(async (f) => {
        const path = await source(f, archive),
          controller = new AbortController(),
          reason = new Error('prepared hash cancelled');
        const hash = hashing.hashDirectory;
        vi.spyOn(hashing, 'hashDirectory').mockImplementation((directory, options) =>
          hash(directory, {
            ...options,
            fileSystem: {
              open,
              readdir,
              readlink,
              // Abort after the actual root stat: hashing has begun on the snapshot.
              lstat: (async (...args: Parameters<typeof lstat>) => {
                const result = await lstat(...args);
                controller.abort(reason);
                return result;
              }) as typeof lstat,
            },
          }),
        );
        const options = {
          cwd: f.roots.cwd,
          temporaryDirectory: f.env.TMPDIR!,
          signal: controller.signal,
        };
        await expect(
          archive ? prepareArchive(path, options) : prepareDirectory(path, options),
        ).rejects.toBe(reason);
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
      }),
  );

  it.each([false, true])(
    'cancels the installed-copy hash without force swallowing it (force=%s)',
    async (force) =>
      withTestEnvironment(async (f) => {
        const path = await source(f);
        const first = new Installer(f);
        await first.add(path, false, ['codex']);
        const paths = getStatePaths(f.roots, 'project'),
          lock = await readFile(paths.lockPath);
        const controller = new AbortController(),
          hash = hashing.hashDirectory;
        let reads = 0;
        vi.spyOn(hashing, 'hashDirectory').mockImplementation((directory, options) =>
          hash(directory, {
            ...options,
            fileSystem: {
              lstat,
              readdir,
              readlink,
              open: async (...args) => {
                const handle = await open(...args);
                if (basename(String(args[0])) === 'large') {
                  const read = handle.read.bind(handle);
                  vi.spyOn(handle, 'read').mockImplementation(
                    async (...args: Parameters<typeof read>) => {
                      reads++;
                      const result = await read(...args);
                      controller.abort();
                      return result;
                    },
                  );
                }
                return handle;
              },
            },
          }),
        );
        expect(
          await new Installer(f, { signal: controller.signal }).add(path, force, ['codex']),
        ).toMatchObject({ status: 'skipped', reason: 'cancelled' });
        expect(reads).toBe(1);
        expect(await readFile(paths.lockPath)).toEqual(lock);
        await expect(lstat(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      }),
  );

  it('preserves abort and close failure together as a preparation error', async () =>
    withTestEnvironment(async (f) => {
      const path = await source(f),
        controller = new AbortController(),
        reason = new Error('cancel copying'),
        closeError = new Error('close failed');
      await expect(
        prepareDirectory(path, {
          cwd: f.roots.cwd,
          temporaryDirectory: f.env.TMPDIR!,
          signal: controller.signal,
          fileSystem: {
            ...directorySourceFileSystem,
            open: async (...args) => {
              const handle = await open(...args);
              if (basename(String(args[0])) === 'large' && args[1] !== 'wx') {
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
              }
              return handle;
            },
          },
        }),
      ).rejects.toMatchObject({
        code: 'PREPARATION_FAILED',
        cause: expect.objectContaining({ errors: [reason, closeError] }),
      });
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
    }));

  it.each(['project', 'global'] as const)(
    'releases the %s scope only after local cancellation cleanup and permits another add',
    async (scope) =>
      withTestEnvironment(async (f) => {
        const path = await source(f),
          controller = new AbortController();
        const paths = getStatePaths(f.roots, scope);
        const first = new Installer(f, { scope });
        await first.add(path, false, ['codex']);
        const lockBefore = await readFile(paths.lockPath),
          hashBefore = await hashDirectory(paths.skillsDirectory);
        const installer = new Installer(f, {
          scope,
          signal: controller.signal,
          prepare: (source, options) =>
            prepareDirectory(source, {
              ...options,
              fileSystem: {
                ...directorySourceFileSystem,
                readdir: async (path) => {
                  const names = await directorySourceFileSystem.readdir(path);
                  controller.abort();
                  return names;
                },
                open: async (...args) => {
                  if (controller.signal.aborted)
                    throw new Error('work continued after cancellation');
                  return directorySourceFileSystem.open(...args);
                },
              },
            }),
        });
        expect(await installer.add(path, false, ['codex'])).toMatchObject({
          status: 'skipped',
          reason: 'cancelled',
        });
        expect(await readFile(paths.lockPath)).toEqual(lockBefore);
        expect(await hashDirectory(paths.skillsDirectory)).toBe(hashBefore);
        await expect(lstat(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(
          (await readdir(paths.agentsDirectory)).filter((name) =>
            name.startsWith('.skills-installer-work-'),
          ),
        ).toEqual([]);
        expect((await first.add(path, false, ['codex'])).status).toBe('unchanged');
      }),
  );
});
