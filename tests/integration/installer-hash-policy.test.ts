import { lstat, mkdir, open, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';

import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { hashDirectory } from '@/state/hash';
import * as hashing from '@/state/hash';
import { Installer } from '@/installer/installer';
import { withTestEnvironment } from '../helpers/test-environment.ts';

const io = { lstat, readdir, readlink, open };

it.skipIf(process.platform === 'win32')(
  'uses the same native policy in global preparation, reuse and updates',
  async () => {
    await withTestEnvironment(async (f) => {
      const source = join(f.roots.cwd, 'source');
      await mkdir(source);
      await writeFile(
        join(source, 'SKILL.md'),
        '---\nname: demo\ndescription: Native skill\n---\nNative global skill\n',
      );
      const resource = Buffer.concat([Buffer.from(source + '/'), Buffer.from('native:resource')]);
      await writeFile(resource, 'first');
      const installer = new Installer(f, { scope: 'global' });
      expect((await installer.add(source)).status).toBe('success');
      expect((await installer.add(source)).status).toBe('unchanged');
      await writeFile(resource, 'second');
      expect((await installer.update('demo')).results).toMatchObject([{ status: 'success' }]);
      const installed = Buffer.concat([
        Buffer.from(join(f.roots.home, '.agents', 'skills', 'demo') + '/'),
        Buffer.from('native:resource'),
      ]);
      expect(await readFile(installed, 'utf8')).toBe('second');
      expect((await installer.remove('demo')).status).toBe('success');
      await expect(lstat(installed)).rejects.toMatchObject({ code: 'ENOENT' });
      await rm(source, { recursive: true });
    });
  },
);
it('does not let force suppress a failed close during installed-content cancellation', async () => {
  await withTestEnvironment(async (f) => {
    const source = join(f.roots.cwd, 'source');
    await mkdir(source);
    await writeFile(join(source, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\nBytes\n');
    await new Installer(f).add(source);
    const controller = new AbortController();
    const reason = new Error('cancel installed hash'),
      closeError = new Error('close failed');
    const actual = hashDirectory;
    vi.spyOn(hashing, 'hashDirectory').mockImplementation((directory, options) =>
      actual(directory, {
        ...options,
        fileSystem: {
          ...io,
          open: async (...args) => {
            const handle = await open(...args);
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
    );
    await expect(
      new Installer(f, { signal: controller.signal }).add(source, true),
    ).rejects.toMatchObject({ errors: [reason, closeError] });
  });
});
