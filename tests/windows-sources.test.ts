import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { prepareArchive } from '../src/sources/archive.ts';
import { archiveSourceFileSystem, OWNED_WORKSPACE_CLEANUP } from '../src/sources/filesystem.ts';
import { archiveBytes, skillText } from './helpers/archive.ts';
import { withTestEnvironment } from './helpers/test-environment.ts';

vi.mock('../src/state/native-path.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/state/native-path.ts')>();
  const { win32 } = await import('node:path');
  return { ...actual, ...actual.createPathOperations(win32) };
});

it('reaches the native Windows extraction destination after validation, including a realpath namespace', async () => {
  await withTestEnvironment(async (f) => {
    const archive = join(f.roots.cwd, 'bytes.tgz');
    await writeFile(archive, archiveBytes([{ path: 'SKILL.md', contents: skillText }]));
    const injected = new Error('stop before physical Windows write'),
      targets: string[] = [];
    const rm = vi.fn(async () => {});
    const fs = {
      ...archiveSourceFileSystem,
      realpath: (async (path: string) =>
        path.endsWith('.TGZ')
          ? archive
          : '\\\\?\\C:\\Temp') as typeof archiveSourceFileSystem.realpath,
      mkdtemp: async () => '\\\\?\\C:\\Temp\\skills-installer-archive-owned',
      mkdir: (async () => {}) as typeof archiveSourceFileSystem.mkdir,
      open: (async (...args: Parameters<typeof archiveSourceFileSystem.open>) => {
        if (args[1] !== 'wx') return archiveSourceFileSystem.open(...args);
        targets.push(String(args[0]));
        throw injected;
      }) as typeof archiveSourceFileSystem.open,
      rm,
    };
    await expect(
      prepareArchive('source.TGZ', {
        cwd: 'C:\\Project',
        temporaryDirectory: 'C:\\Temp',
        fileSystem: fs,
      }),
    ).rejects.toMatchObject({ code: 'PREPARATION_FAILED', cause: injected });
    expect(targets).toEqual(['\\\\?\\C:\\Temp\\skills-installer-archive-owned\\skill\\SKILL.md']);
    expect(rm).toHaveBeenCalledWith(
      '\\\\?\\C:\\Temp\\skills-installer-archive-owned',
      OWNED_WORKSPACE_CLEANUP,
    );
  });
});
