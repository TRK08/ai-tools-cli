import { lstat, stat, symlink as fsSymlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { withTestEnvironment } from './test-environment.ts';

/** Проверяет право создания именно файловых symlink; directory junction этого права не требует. */
export const fileSymlinks = await withTestEnvironment(async (f) => {
  const target = resolve(f.roots.cwd, 'target');
  const link = resolve(f.roots.cwd, 'link');
  await writeFile(target, 'capability');
  try {
    await fsSymlink(target, link, 'file');
    return (await lstat(link)).isSymbolicLink();
  } catch (cause) {
    if (
      process.platform === 'win32' &&
      cause instanceof Error &&
      'code' in cause &&
      ['EPERM', 'EACCES', 'ENOSYS'].includes(String(cause.code))
    )
      return false;
    throw cause;
  }
});

/** Создаёт directory fixtures как абсолютные Windows junction; file/cycle fixtures требуют capability. */
export async function symlink(target: string, path: string, type?: 'dir' | 'file') {
  const absolute = resolve(dirname(path), target);
  const directory =
    type === 'dir' ||
    (type === undefined &&
      (await stat(absolute).then(
        (s) => s.isDirectory(),
        () => true,
      )));
  return fsSymlink(
    process.platform === 'win32' && directory ? absolute : target,
    path,
    process.platform === 'win32' && directory ? 'junction' : directory ? 'dir' : 'file',
  );
}
