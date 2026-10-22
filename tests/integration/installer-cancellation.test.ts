import { lstat, mkdir, open, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { prepareDirectory } from '@/sources/directory';

import { directorySourceFileSystem } from '@/sources/filesystem';
import { hashDirectory } from '@/state/hash';
import * as hashing from '@/state/hash';
import { Installer } from '@/installer/installer';
import { getStatePaths } from '@/state/paths';
import { archiveBytes, skillText } from '../helpers/archive.ts';
import { withTestEnvironment, type TestEnvironment } from '../helpers/test-environment.ts';

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
                if (controller.signal.aborted) throw new Error('work continued after cancellation');
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
