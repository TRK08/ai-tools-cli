import { expect, it, vi } from 'vitest';
import { agentSkillsDirectory } from '../../src/installer/agents.ts';
import { InstallationInspection } from '../../src/installer/inspection.ts';
import { installerFileSystem } from '../../src/installer/filesystem.ts';
import { selectSource } from '../../src/installer/source.ts';

import { getStatePaths } from '../../src/state/paths.ts';

import { LOCK_VERSION, type LockFile } from '../../src/state/types.ts';
import type { RuntimeContext } from '../../src/runtime.ts';

vi.mock('../../src/state/native-path.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state/native-path.ts')>();
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

it('rejects a cross-drive source before any source preparation or HTTP', async () => {
  const http = vi.fn(context.http);
  await expect(
    selectSource('D:\\sources\\demo', { ...context, http }, project, {}),
  ).rejects.toMatchObject({ code: 'INVALID_PATH' });
  expect(http).not.toHaveBeenCalled();
});
it('checks Windows link ownership and its target across drives and namespace spelling', async () => {
  const fs = {
    ...installerFileSystem,
    lstat: vi.fn(async (path: string) => ({
      isDirectory: () => !path.endsWith('\\demo'),
      isSymbolicLink: () => path.endsWith('\\demo'),
    })) as unknown as typeof installerFileSystem.lstat,
    readlink: vi.fn(
      async () => '\\\\?\\c:\\USERS\\ТЕСТ\\.agents\\skills\\demo',
    ) as unknown as typeof installerFileSystem.readlink,
  };
  const inspection = new InstallationInspection(context, global, fs);
  const connection = {
    agent: 'claude-code' as const,
    kind: 'link' as const,
    path: 'D:\\Claude\\skills\\demo',
  };
  await expect(inspection.inspectConnection(connection, 'demo', true)).resolves.toBe(true);
  await expect(inspection.inspectConnection(connection, 'demo', false)).rejects.toThrow('чужим');
  fs.readlink = vi.fn(
    async () => 'C:\\Outside\\demo',
  ) as unknown as typeof installerFileSystem.readlink;
  await expect(inspection.inspectConnection(connection, 'demo', true)).rejects.toThrow('чужим');
});
it('accepts the separate Claude destination and validates its native catalog path', () => {
  const inspection = new InstallationInspection(context, project, installerFileSystem);
  expect(inspection.connection('demo', 'claude-code')).toEqual({
    agent: 'claude-code',
    path: '.claude/skills/demo',
    kind: 'copy',
  });
  expect(() => inspection.assertSupported(windowsLock().skills.demo!)).not.toThrow();
  expect(() =>
    inspection.assertSupported({
      ...windowsLock().skills.demo!,
      connections: [{ agent: 'claude-code', kind: 'link' as const, path: '.other/skills/demo' }],
    }),
  ).toThrow();
});
it('validates native agent paths and rejects drive-relative env overrides', () => {
  expect(agentSkillsDirectory(context, 'project', 'claude-code')).toBe(
    roots.cwd + '\\.claude\\skills',
  );
  expect(() =>
    agentSkillsDirectory(
      { ...context, env: { CLAUDE_CONFIG_DIR: 'D:claude' } },
      'global',
      'claude-code',
    ),
  ).toThrow();
});
