import type { Stats } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { FileTransaction, installerFileSystem } from '../../src/installer/filesystem.ts';
import { InstallationInspection } from '../../src/installer/inspection.ts';
import { getStatePaths } from '../../src/state/paths.ts';
import type { RuntimeContext } from '../../src/runtime.ts';

vi.mock('../../src/state/native-path.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state/native-path.ts')>();
  const { win32 } = await import('node:path');
  return { ...actual, ...actual.createPathOperations(win32) };
});

const context: RuntimeContext = {
  roots: { cwd: 'C:\\Project', home: 'C:\\Users\\Test' },
  env: { CLAUDE_CONFIG_DIR: 'D:\\Claude' },
  http: async () => {
    throw new Error('HTTP disabled');
  },
};
const paths = getStatePaths(context.roots, 'global');
const target = 'C:\\Users\\Test\\.agents\\skills\\demo';
const link = 'D:\\Claude\\skills\\demo';
const workspace = 'C:\\Users\\Test\\.agents\\.skills-installer-work-test';

function fixture() {
  const links = new Map<string, string>();
  const directory = { isDirectory: () => true, isSymbolicLink: () => false } as Stats;
  const junction = { isDirectory: () => false, isSymbolicLink: () => true } as Stats;
  const fs = {
    ...installerFileSystem,
    mkdtemp: vi.fn(async () => workspace),
    lstat: vi.fn(async (path: string) => {
      if (links.has(path)) return junction;
      if (path === link || path === target)
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return directory;
    }),
    readlink: vi.fn(async () => {
      const value = links.get(link);
      if (!value) throw new Error('not a junction');
      return value;
    }) as unknown as typeof installerFileSystem.readlink,
    symlink: vi.fn<typeof installerFileSystem.symlink>(async (value, path, type) => {
      expect(type).toBe('junction');
      if (links.has(String(path))) throw new Error('already exists');
      links.set(String(path), String(value));
    }),
    rm: vi.fn(async (path: unknown) => {
      links.delete(String(path));
    }),
    rename: vi.fn().mockRejectedValue(Object.assign(new Error('cross-volume'), { code: 'EXDEV' })),
  };
  return { fs, links };
}

describe('Windows junctions with modeled I/O', () => {
  it('creates an absolute junction and rolls back only its object on failure', async () => {
    const { fs, links } = fixture();
    await expect(
      FileTransaction.run(paths.agentsDirectory, fs, async (files) => {
        await files.link(target, link);
        expect(links.get(link)).toBe(target);
        throw new Error('commit failed');
      }),
    ).rejects.toThrow('commit failed');
    expect(fs.symlink).toHaveBeenCalledWith(target, link, 'junction');
    expect(fs.rm).toHaveBeenCalledWith(link);
    expect(fs.rm).not.toHaveBeenCalledWith(target);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(links.size).toBe(0);
  });

  it.each([false, true])(
    'recognizes case/namespace and unlinks a dangling junction on another drive, rollback=%j',
    async (rollback) => {
      const { fs, links } = fixture();
      const spelling = '\\\\?\\c:\\USERS\\TEST\\.AGENTS\\skills\\demo';
      links.set(link, spelling);
      const inspection = new InstallationInspection(context, paths, fs);
      const connection = inspection.connection('demo', 'claude-code');
      expect(connection).toEqual({ agent: 'claude-code', kind: 'link', path: link });
      expect(await inspection.inspectConnection(connection, 'demo', true)).toBe(true);
      const pending = FileTransaction.run(paths.agentsDirectory, fs, async (files) => {
        await files.unlink(link, target);
        if (rollback) throw new Error('commit failed');
      });
      if (rollback) {
        await expect(pending).rejects.toThrow('commit failed');
        expect(fs.symlink).toHaveBeenCalledWith(spelling, link, 'junction');
        expect(links.get(link)).toBe(spelling);
      } else {
        await pending;
        expect(links.has(link)).toBe(false);
        expect(fs.symlink).not.toHaveBeenCalled();
      }
      expect(fs.rename).not.toHaveBeenCalled();
      expect(fs.rm).not.toHaveBeenCalledWith(target);
      expect(fs.lstat).not.toHaveBeenCalledWith(target);
    },
  );

  it('refuses an external target and redirected parents before mutation', async () => {
    const { fs, links } = fixture();
    const inspection = new InstallationInspection(context, paths, fs);
    const connection = inspection.connection('demo', 'claude-code');
    links.set(link, 'C:\\Other\\demo');
    await expect(inspection.inspectConnection(connection, 'demo', true)).rejects.toThrow(
      'чужим объектом',
    );
    links.set(link, target);
    links.set('D:\\Claude', 'E:\\Elsewhere');
    await expect(inspection.inspectConnection(connection, 'demo', true)).rejects.toThrow(
      'Ожидался обычный каталог',
    );
    expect(fs.rm).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it('propagates junction failure without falling back to a physical copy', async () => {
    const { fs } = fixture();
    fs.symlink.mockRejectedValueOnce(
      Object.assign(new Error('junction denied'), { code: 'EPERM' }),
    );
    const cp = vi.fn(installerFileSystem.cp);
    await expect(
      FileTransaction.run(paths.agentsDirectory, { ...fs, cp }, (files) =>
        files.link(target, link),
      ),
    ).rejects.toThrow('junction denied');
    expect(cp).not.toHaveBeenCalled();
    expect(fs.rm).toHaveBeenCalledTimes(1);
    expect(fs.rm).toHaveBeenCalledWith(workspace, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });
});
