import { posix } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { InstallationInspection } from '@/installer/inspection';
import { installerFileSystem } from '@/installer/filesystem';

import { assertPortableName, assertPortableNames, portableNameKey } from '@/paths/names';
import {
  createPathOperations,
  assertResourceNames,
  childBufferPath,
  hasBufferPathPrefix,
  isBufferPathWithin,
  isPathWithin,
  pathIdentityKey,
  relativePathParts,
  samePath,
  validateNativePath,
} from '@/paths/native-path';
import {
  assertSkillName,
  getStatePaths,
  portableConnectionPath,
  portableSourcePath,
  resolveConnectionPath,
  resolveSourcePath,
  validatePortablePathText,
} from '@/state/paths';
import { sourceIdentityKey } from '@/state/identity';
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
    skills: {
      demo: {
        name: 'demo',
        source: { kind: 'directory', path: roots.cwd + '\\sources\\demo' },
        version: null,
        policy: 'local',
        contentHash: 'a'.repeat(64),
        agents: ['codex', 'claude-code'],
        connections: [
          { agent: 'codex', kind: 'direct' as const, path: roots.cwd + '\\.agents\\skills\\demo' },
          {
            agent: 'claude-code',
            kind: 'copy' as const,
            path: roots.cwd + '\\.claude\\skills\\demo',
          },
        ],
      },
    },
  };
}

describe('native and portable paths', () => {
  it('walks byte paths with Windows case, namespaces and component boundaries', () => {
    expect(childBufferPath(Buffer.from('C:\\Work'), Buffer.from('Ресурс'))).toEqual(
      Buffer.from('C:\\Work\\Ресурс'),
    );
    expect(isBufferPathWithin(Buffer.from('C:\\Work'), Buffer.from('\\\\?\\c:\\WORK\\child'))).toBe(
      true,
    );
    expect(isBufferPathWithin(Buffer.from('C:\\Work'), Buffer.from('D:\\Work\\child'))).toBe(false);
    expect(isBufferPathWithin(Buffer.from('C:\\Work'), Buffer.from('C:\\Work-other\\child'))).toBe(
      false,
    );
    expect(isBufferPathWithin(Buffer.from('C:\\Work'), Buffer.from('C:\\Work\\..\\outside'))).toBe(
      false,
    );
    expect(
      hasBufferPathPrefix(
        Buffer.from('\\\\?\\c:\\WORK\\.skills-installer-work-123\\file'),
        Buffer.from('C:\\Work\\.skills-installer-work-'),
      ),
    ).toBe(true);
    expect(
      hasBufferPathPrefix(
        Buffer.from('C:\\Work-other\\.skills-installer-work-123'),
        Buffer.from('C:\\Work\\.skills-installer-work-'),
      ),
    ).toBe(false);
  });

  it('preserves non-UTF-8 POSIX bytes when joining and comparing realpath results', () => {
    const api = createPathOperations(posix),
      rawRoot = Buffer.from([47, 255, 254]);
    const child = api.childBufferPath(rawRoot, Buffer.from([253]));
    expect(child).toEqual(Buffer.from([47, 255, 254, 47, 253]));
    expect(api.isBufferPathWithin(rawRoot, child)).toBe(true);
    expect(api.isBufferPathWithin(rawRoot, Buffer.from([47, 255, 254, 253]))).toBe(false);
    expect(
      api.isBufferPathWithin(rawRoot, Buffer.concat([rawRoot, Buffer.from('/../outside')])),
    ).toBe(false);
    expect(api.isBufferPathWithin(Buffer.from('/'), child)).toBe(true);
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

  it('uses native Windows roots and keeps project lock paths portable', () => {
    expect(project.skillsDirectory).toBe(roots.cwd + '\\.agents\\skills');
    const json = serializeLockFile(windowsLock(), project);
    expect(json).not.toContain('C:');
    const lock = parseLockFile(JSON.parse(json), project);
    expect(lock.skills.demo?.source).toEqual({ kind: 'directory', path: 'sources/demo' });
    expect(lock.skills.demo?.connections.map((connection) => connection.path)).toEqual([
      '.claude/skills/demo',
      '.agents/skills/demo',
    ]);
    const moved = getStatePaths({ ...roots, cwd: 'D:\\Перенесённый проект' }, 'project');
    expect(resolveSourcePath('sources/demo', moved)).toBe('D:\\Перенесённый проект\\sources\\demo');
    expect(resolveConnectionPath('.claude/skills/demo', moved)).toBe(
      'D:\\Перенесённый проект\\.claude\\skills\\demo',
    );
  });

  it('accepts both native Windows separators and external sources on the same drive', () => {
    expect(portableSourcePath('.\\sources/demo', project)).toBe('sources/demo');
    expect(portableSourcePath('C:/Projects/External/demo', project)).toBe('../External/demo');
    expect(portableConnectionPath('.agents\\skills/demo', project)).toBe('.agents/skills/demo');
    expect(portableSourcePath('.', project)).toBe('.');
    expect(() => portableSourcePath('D:\\sources\\demo', project)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PATH' }),
    );
  });

  it.each([
    '',
    'C:',
    'C:relative',
    '1:\\project',
    'K:\\project',
    '\\rooted',
    '/rooted',
    '\\\\server\\share\\project',
    '//server/share/project',
    '\\\\?\\C:\\project',
    '\\\\.\\C:\\project',
    'C:\\file:stream',
    'C:\\folder\\NUL.txt',
    'C:\\folder.\\project',
    'C:\\bad\\line\nbreak',
  ])('rejects unsupported Windows input %j before resolution', (path) => {
    expect(() => validateNativePath(path)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PATH' }),
    );
  });

  it('keeps global paths native and allows another local drive', () => {
    expect(portableSourcePath('D:\\Sources\\demo', global)).toBe('D:\\Sources\\demo');
    expect(portableConnectionPath('D:\\Claude\\skills\\demo', global)).toBe(
      'D:\\Claude\\skills\\demo',
    );
    expect(() => portableConnectionPath('.claude/skills/demo', global)).toThrow();
    const lock = windowsLock();
    const record = lock.skills.demo!;
    const json = serializeLockFile(
      {
        ...lock,
        skills: {
          demo: {
            ...record,
            connections: [
              {
                agent: 'codex',
                kind: 'direct' as const,
                path: roots.home + '\\.agents\\skills\\demo',
              },
            ],
          },
        },
      },
      global,
    );
    expect(parseLockFile(JSON.parse(json), global).skills.demo?.source).toEqual(record.source);
  });

  it.each(['..\\escape', '../escape', 'C:\\outside', 'D:\\outside', '.'])(
    'rejects a managed project destination outside the root: %j',
    (path) => {
      expect(() => portableConnectionPath(path, project)).toThrow();
    },
  );

  it('rejects native backslashes in stored project paths on Windows as well', () => {
    const stored = JSON.parse(serializeLockFile(windowsLock(), project));
    stored.skills.demo.source.path = 'sources\\demo';
    expect(() => parseLockFile(stored, project)).toThrowError(
      expect.objectContaining({ code: 'INVALID_LOCK' }),
    );
  });

  it('compares Windows paths without changing their I/O spelling or dereferencing symlinks', () => {
    expect(samePath('C:\\Work\\Project\\', 'c:/work/PROJECT')).toBe(true);
    expect(samePath('C:\\Work\\alias', 'C:\\Work\\target')).toBe(false);
    expect(pathIdentityKey('\\\\?\\C:\\Work\\Project')).toBe('c:\\work\\project');
    expect(sourceIdentityKey({ kind: 'directory', path: 'sources/demo' }, project)).toBe(
      sourceIdentityKey(
        { kind: 'directory', path: 'c:/PROJECTS/Мой проект/SOURCES/DEMO' },
        project,
      ),
    );
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

  it('rejects skill dictionary names that collide before accepting the lock', () => {
    const lock = windowsLock();
    const record = lock.skills.demo!;
    expect(() =>
      serializeLockFile(
        { ...lock, skills: { demo: record, Demo: { ...record, name: 'Demo' } } },
        project,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_LOCK' }));
  });

  it('rejects global destinations shared by different records with different casing', () => {
    const record = windowsLock().skills.demo!;
    expect(() =>
      serializeLockFile(
        {
          version: LOCK_VERSION,
          skills: {
            first: {
              ...record,
              name: 'first',
              agents: ['claude-code'],
              connections: [
                { agent: 'claude-code', kind: 'link' as const, path: 'D:\\Claude\\skills\\shared' },
              ],
            },
            second: {
              ...record,
              name: 'second',
              agents: ['claude-code'],
              connections: [
                { agent: 'claude-code', kind: 'link' as const, path: 'd:\\CLAUDE\\skills\\SHARED' },
              ],
            },
          },
        },
        global,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_LOCK' }));
  });
});
