import { posix } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { InstallationInspection } from '@/installer/inspection';
import { installerFileSystem } from '@/installer/filesystem';

import { assertPortableName, assertPortableNames, portableNameKey } from '@/paths/names';
import {
  createPathOperations,
  assertResourceNames,
  childBufferPath,
  isPathWithin,
  pathIdentityKey,
  relativePathParts,
  samePath,
} from '@/paths/native-path';
import {
  assertSkillName,
  getStatePaths,
  portableConnectionPath,
  validatePortablePathText,
} from '@/state/paths';
import { parseLockFile, serializeLockFile } from '@/state/schema';
import { LOCK_VERSION, type LockFile } from '@/state/types';
import type { RuntimeContext } from '@/runtime';

vi.mock('@/paths/native-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/paths/native-path')>();
  const { win32 } = await import('node:path');
  return { ...actual, ...actual.createPathOperations(win32) };
});

const roots = { cwd: 'C:\\Projects\\Мой проект', home: 'C:\\Users\\Тест' };
const project = getStatePaths(roots, 'project');
const global = getStatePaths(roots, 'global');
const context: RuntimeContext = {
  roots,
  env: {},
  http: async () => {
    throw new Error('HTTP is disabled.');
  },
};

function windowsLock(): LockFile {
  return {
    version: LOCK_VERSION,
    packages: [
      {
        slug: 'pkg',
        registryUrl: 'http://registry.test',
        version: '1.0.0',
        skills: [
          {
            name: 'demo',
            installName: 'demo',
            contentHash: 'a'.repeat(64),
            archiveHash: 'b'.repeat(64),
            connections: [
              { agent: 'codex', kind: 'direct', path: project.cwd + '/.agents/skills/demo' },
            ],
          },
        ],
      },
    ],
  };
}

describe('native and portable paths', () => {
  it('joins Windows byte paths with the native separator', () => {
    expect(childBufferPath(Buffer.from('C:\\Work'), Buffer.from('Ресурс'))).toEqual(
      Buffer.from('C:\\Work\\Ресурс'),
    );
  });

  it('preserves non-UTF-8 POSIX bytes when joining paths', () => {
    const api = createPathOperations(posix),
      rawRoot = Buffer.from([47, 255, 254]);
    const child = api.childBufferPath(rawRoot, Buffer.from([253]));
    expect(child).toEqual(Buffer.from([47, 255, 254, 47, 253]));
    expect(() => api.assertResourceNames([Buffer.from([253])], false)).not.toThrow();
    expect(() => api.assertResourceNames([Buffer.from([253])])).toThrow();
  });

  it.each(['CON', 'nul.txt', 'COM1', 'file:stream', 'tail.', 'tail '])(
    'cannot disable Windows name restrictions for global resources: %j',
    (name) => {
      expect(() => assertResourceNames([Buffer.from(name)], false)).toThrow();
    },
  );

  it('cannot disable Windows collisions or invalid UTF-8 and uses the native UTF-16 limit', () => {
    for (const names of [['A', 'a'], ['café', 'cafe\u0301'], [Buffer.from([255])]]) {
      expect(() =>
        assertResourceNames(
          names.map((name) => Buffer.from(name)),
          false,
        ),
      ).toThrow();
    }
    expect(() => assertResourceNames([Buffer.from('工具'.repeat(80))], false)).not.toThrow();
    expect(() => assertResourceNames([Buffer.from('工具'.repeat(80))], true)).toThrow();
  });

  it('writes relative project paths with / and rejects native backslashes on disk', () => {
    const stored = JSON.parse(serializeLockFile(windowsLock(), project));
    expect(parseLockFile(stored, project).packages[0]?.skills[0]?.connections[0]?.path).toBe(
      '.agents/skills/demo',
    );
    stored.packages[0].skills[0].connections[0].path = '.agents\\skills\\demo';
    expect(() => parseLockFile(stored, project)).toThrow();
  });

  it('keeps a global Claude connection on a different Windows drive', () => {
    const lock = windowsLock();
    const pkg = lock.packages[0]!;
    const skill = pkg.skills[0]!;
    const path = 'D:\\Claude\\skills\\demo';
    const serialized = serializeLockFile(
      {
        ...lock,
        packages: [
          {
            ...pkg,
            skills: [
              {
                ...skill,
                connections: [{ agent: 'claude-code', kind: 'link', path }],
              },
            ],
          },
        ],
      },
      global,
    );
    expect(
      parseLockFile(JSON.parse(serialized), global).packages[0]?.skills[0]?.connections[0]?.path,
    ).toBe(path);
  });

  it.each(['..\\escape', '../escape', 'C:\\outside', 'D:\\outside', '.'])(
    'rejects a project connection outside cwd: %s',
    (path) => {
      expect(() => portableConnectionPath(path, project)).toThrow();
    },
  );

  it('compares Windows paths without changing their I/O spelling or dereferencing symlinks', () => {
    expect(samePath('C:\\Work\\Project\\', 'c:/work/PROJECT')).toBe(true);
    expect(samePath('C:\\Work\\alias', 'C:\\Work\\target')).toBe(false);
    expect(pathIdentityKey('\\\\?\\C:\\Work\\Project')).toBe('c:\\work\\project');
    expect(() =>
      getStatePaths({ cwd: 'c:\\USERS\\ТЕСТ', home: roots.home }, 'project'),
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_IN_HOME' }));
  });

  it('checks containment by components, including roots, siblings and different drives', () => {
    expect(isPathWithin('C:\\Work', 'c:/work/child')).toBe(true);
    expect(isPathWithin('C:\\Work', 'C:\\Work')).toBe(true);
    expect(isPathWithin('C:\\Work', 'C:\\Work-other\\child')).toBe(false);
    expect(isPathWithin('C:\\Work', 'C:\\Work\\..\\outside')).toBe(false);
    expect(isPathWithin('C:\\Work', 'D:\\Work\\child')).toBe(false);
    expect(relativePathParts('C:\\Work', 'c:\\work\\.claude\\skills')).toEqual([
      '.claude',
      'skills',
    ]);
    expect(relativePathParts('C:\\Work', '\\\\?\\C:\\Work\\Child')).toEqual(['Child']);
    expect(() => relativePathParts('C:\\Work', 'C:\\outside')).toThrow();
  });

  it('retains POSIX case sensitivity and treats backslash as a native filename character', () => {
    const posixOperations = createPathOperations(posix);
    expect(posixOperations.samePath('/repo/A', '/repo/a')).toBe(false);
    expect(posixOperations.isPathWithin('/repo', '/repo-other/file')).toBe(false);
    expect(() => posixOperations.validateNativePath('/repo/has\\backslash')).not.toThrow();
    expect(() => validatePortablePathText('has\\backslash')).toThrow();
  });

  it('walks every Windows connection parent and stops at a redirected parent', async () => {
    const lstat = vi.fn(
      async (
        _path: string,
      ): Promise<{
        isDirectory: () => boolean;
        isSymbolicLink: () => boolean;
      }> => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }),
    );
    const inspection = new InstallationInspection(context, project, {
      ...installerFileSystem,
      lstat: lstat as unknown as typeof installerFileSystem.lstat,
    });
    await inspection.connectionParents(roots.cwd + '\\.claude\\skills\\demo');
    expect(lstat.mock.calls.map(([path]) => path)).toEqual([
      roots.cwd + '\\.claude',
      roots.cwd + '\\.claude\\skills',
    ]);
    lstat.mockResolvedValueOnce({ isDirectory: () => true, isSymbolicLink: () => true });
    await expect(
      inspection.connectionParents(roots.cwd + '\\.claude\\skills\\demo'),
    ).rejects.toThrow('ссылка');
  });
});

describe('portable names', () => {
  it.each([
    'CON',
    'nul.txt',
    'PRN.md',
    'AUX',
    'com1',
    'LPT9.log',
    'COM¹.txt',
    'lpt²',
    'CON .txt',
    'CONIN$',
    'conout$',
    'demo.',
    'demo ',
    'bad:name',
    'a?b',
    'a*b',
    'a|b',
    'a<b',
    'a>b',
    'a"b',
    '\ud800',
    '',
  ])('rejects unsafe name %j without rewriting it', (name) => {
    expect(() => assertSkillName(name)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PATH' }),
    );
  });

  it('accepts portable Unicode, spaces and names resembling reserved words', () => {
    for (const name of ['Мой скилл', 'café', '工具', '😀', 'COM0', 'COM10', 'console', '.hidden']) {
      expect(() => assertPortableName(name)).not.toThrow();
    }
    expect(() => assertPortableName(Buffer.from([0xff, 0xfe]))).toThrow();
    expect(() => assertPortableName('ä'.repeat(128))).toThrow();
    expect(() => assertPortableName(Buffer.from('Мой скилл'))).not.toThrow();
  });

  it.each([
    ['Readme', 'README'],
    ['café', 'cafe\u0301'],
    ['Demo', Buffer.from('demo')],
  ])('rejects name collisions for %j and %j', (first, second) => {
    expect(() => assertPortableNames([first, second])).toThrow();
  });

  it('does not modify the names while calculating collision keys', () => {
    const decomposed = 'cafe\u0301';
    expect(portableNameKey(decomposed)).toBe('café');
    expect(decomposed).toBe('cafe\u0301');
    expect(() => assertPortableNames(['first', 'second'])).not.toThrow();
  });
});
