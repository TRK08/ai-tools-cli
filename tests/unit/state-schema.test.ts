import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { symlink } from '../helpers/links.ts';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENTS, agentConnectionKind } from '@/agents/catalog';

import { getSkillDirectory, getStatePaths } from '@/state/paths';
import { parseLockFile, serializeLockFile } from '@/state/schema';
import { StateStore } from '@/state/store';
import { createEmptyLock, type InstallationRecord, type LockFile } from '@/state/types';
import { withTestEnvironment, type TestEnvironment } from '../helpers/test-environment.ts';

function directoryRecord(fixture: TestEnvironment, name = 'demo'): InstallationRecord {
  return {
    name,
    source: { kind: 'directory', path: join(fixture.roots.cwd, 'sources', name) },
    version: null,
    policy: 'local',
    contentHash: 'a'.repeat(64),
    agents: ['codex', 'claude-code'],
    connections: [
      {
        agent: 'codex',
        kind: 'direct' as const,
        path: join(fixture.roots.cwd, '.agents', 'skills', name),
      },
    ],
  };
}

function oneRecord(record: InstallationRecord): LockFile {
  return { version: 1, skills: { [record.name]: record } };
}

describe('strict lock reading', () => {
  it.each(['project', 'global'] as const)(
    'validates connection kinds against the current catalog in %s scope',
    async (scope) => {
      await withTestEnvironment(async (fixture) => {
        const paths = getStatePaths(fixture.roots, scope);
        for (const agent of AGENTS) {
          const kind = agentConnectionKind(agent.id, scope);
          const record: InstallationRecord = {
            ...directoryRecord(fixture),
            agents: [agent.id],
            connections: [
              {
                agent: agent.id,
                kind,
                path:
                  agent.id === 'claude-code'
                    ? join(
                        scope === 'project' ? fixture.roots.cwd : fixture.roots.home,
                        '.claude',
                        'skills',
                        'demo',
                      )
                    : getSkillDirectory(paths, 'demo'),
              },
            ],
          };
          const valid = JSON.parse(serializeLockFile(oneRecord(record), paths));
          expect(parseLockFile(valid, paths).skills.demo?.connections[0]?.kind).toBe(kind);
          for (const wrong of [
            undefined,
            null,
            'unknown',
            'symlink',
            'direct',
            'copy',
            'link',
          ].filter((value) => value !== kind)) {
            const invalid = structuredClone(valid);
            if (wrong === undefined) delete invalid.skills.demo.connections[0].kind;
            else invalid.skills.demo.connections[0].kind = wrong;
            expect(() => parseLockFile(invalid, paths)).toThrowError(
              expect.objectContaining({ code: 'INVALID_LOCK' }),
            );
          }
          const extraField = structuredClone(valid);
          extraField.skills.demo.connections[0].unexpected = true;
          expect(() => parseLockFile(extraField, paths)).toThrow();
        }
      });
    },
  );

  it.each([null, '1', 0, 2, 99, -1, 1.5])('rejects any noncurrent version: %s', async (version) => {
    await withTestEnvironment(async (fixture) => {
      expect(() =>
        parseLockFile({ version, skills: {} }, getStatePaths(fixture.roots, 'project')),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_LOCK' }));
    });
  });

  it('allows project direct-reader agents to share only their own canonical directory', async () => {
    await withTestEnvironment(async (fixture) => {
      const paths = getStatePaths(fixture.roots, 'project');
      const canonical = '.agents/skills/demo';
      const record: InstallationRecord = {
        ...directoryRecord(fixture),
        agents: ['codex', 'opencode', 'cursor', 'claude-code'],
        connections: [
          { agent: 'codex', kind: 'direct' as const, path: canonical },
          { agent: 'opencode', kind: 'direct' as const, path: canonical },
          { agent: 'cursor', kind: 'direct' as const, path: canonical },
          { agent: 'claude-code', kind: 'copy' as const, path: '.claude/skills/demo' },
        ],
      };
      const parsed = parseLockFile(JSON.parse(serializeLockFile(oneRecord(record), paths)), paths);
      expect(parsed.skills.demo?.connections).toHaveLength(4);
      expect(() =>
        serializeLockFile(
          oneRecord({
            ...record,
            connections: record.connections.map((connection) => ({
              ...connection,
              path: canonical,
            })),
          }),
          paths,
        ),
      ).toThrow();
      expect(() =>
        serializeLockFile(
          oneRecord({
            ...record,
            connections: record.connections.map((connection) => ({
              ...connection,
              path: '.agents/skills/another',
            })),
          }),
          paths,
        ),
      ).toThrow();
      expect(() =>
        serializeLockFile(
          oneRecord({ ...record, connections: [record.connections[0]!, record.connections[0]!] }),
          paths,
        ),
      ).toThrow();
      const global = getStatePaths(fixture.roots, 'global');
      expect(() =>
        serializeLockFile(
          oneRecord({
            ...record,
            connections: record.connections.map((connection) => ({
              ...connection,
              path: getSkillDirectory(global, 'demo'),
            })),
          }),
          global,
        ),
      ).toThrow();
    });
  });

  it('rejects multiple skill records claiming the same managed path', async () => {
    await withTestEnvironment(async (fixture) => {
      const paths = getStatePaths(fixture.roots, 'project');
      const alpha = directoryRecord(fixture, 'alpha');
      const beta = { ...directoryRecord(fixture, 'beta'), connections: alpha.connections };
      expect(() => serializeLockFile({ version: 1, skills: { alpha, beta } }, paths)).toThrow();
    });
  });

  it('returns null for missing state without creating directories, distinct from an empty lock', async () => {
    await withTestEnvironment(async (fixture) => {
      const paths = getStatePaths(fixture.roots, 'project');
      const store = new StateStore(paths);
      expect(await store.read()).toBeNull();
      await expect(access(paths.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await mkdir(paths.root, { recursive: true });
      expect(await store.read()).toBeNull();
      await store.write(createEmptyLock());
      expect(await store.read()).toEqual(createEmptyLock());
    });
  });

  it.each([
    { name: 'malformed JSON', content: '{broken', code: 'INVALID_LOCK' },
    { name: 'array root', content: '[]', code: 'INVALID_LOCK' },
    { name: 'missing skills', content: '{"version":1}', code: 'INVALID_LOCK' },
    {
      name: 'future version',
      content: '{"version":99,"skills":{}}',
      code: 'INVALID_LOCK',
    },
    { name: 'old version', content: '{"version":0,"skills":{}}', code: 'INVALID_LOCK' },
    { name: 'noninteger version', content: '{"version":"1","skills":{}}', code: 'INVALID_LOCK' },
    {
      name: 'partial record',
      content: '{"version":1,"skills":{"demo":{"name":"demo"}}}',
      code: 'INVALID_LOCK',
    },
    {
      name: 'unknown field',
      content: '{"version":1,"skills":{},"downloadUrl":"https://temporary.test"}',
      code: 'INVALID_LOCK',
    },
  ])('rejects $name without overwriting it', async (scenario) => {
    await withTestEnvironment(async (fixture) => {
      const paths = getStatePaths(fixture.roots, 'project');
      await mkdir(paths.root, { recursive: true });
      await writeFile(paths.lockPath, scenario.content);
      const store = new StateStore(paths);
      await expect(store.read()).rejects.toMatchObject({ code: scenario.code });
      await expect(store.update(() => createEmptyLock())).rejects.toMatchObject({
        code: scenario.code,
      });
      expect(await readFile(paths.lockPath, 'utf8')).toBe(scenario.content);
      await expect(access(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('rejects inconsistent records, signed URLs, unknown agents and nonportable persisted paths', async () => {
    await withTestEnvironment(async (fixture) => {
      const paths = getStatePaths(fixture.roots, 'project');
      const baseline = JSON.parse(
        serializeLockFile(oneRecord(directoryRecord(fixture)), paths),
      ) as { version: 1; skills: { demo: Record<string, unknown> } };
      const mutations: ((record: Record<string, unknown>) => void)[] = [
        (record) => {
          record.name = 'different';
        },
        (record) => {
          record.contentHash = 'bad';
        },
        (record) => {
          record.agents = ['unknown'];
        },
        (record) => {
          record.agents = ['codex', 'codex'];
        },
        (record) => {
          record.agents = [];
        },
        (record) => {
          record.policy = 'latest';
        },
        (record) => {
          record.connections = [{ agent: 'pi', kind: 'direct' as const, path: '.pi/skills/demo' }];
        },
        (record) => {
          record.connections = [{ agent: 'codex', kind: 'direct' as const, path: '../outside' }];
        },
        (record) => {
          record.connections = [
            {
              agent: 'codex',
              kind: 'direct' as const,
              path: join(fixture.roots.cwd, '.agents/skills/demo'),
            },
          ];
        },
        (record) => {
          record.source = { kind: 'directory', path: fixture.roots.cwd };
        },
        (record) => {
          record.source = { kind: 'directory', path: 'C:\\Users\\developer' };
        },
        (record) => {
          record.source = {
            kind: 'registry',
            registryUrl: 'https://registry.test?signature=secret',
            slug: 'demo',
          };
        },
        (record) => {
          record.source = {
            kind: 'registry',
            registryUrl: 'https://registry.test',
            slug: 'demo',
            artifactUrl: 'https://temporary.test',
          };
        },
        (record) => {
          record.archiveHash = 'b'.repeat(64);
        },
      ];
      for (const change of mutations) {
        const invalid = structuredClone(baseline);
        change(invalid.skills.demo);
        expect(() => parseLockFile(invalid, paths)).toThrow();
      }
      expect(() => parseLockFile(baseline, getStatePaths(fixture.roots, 'global'))).toThrow();
    });
  });

  it('rejects state-root and lock symlinks without reading or writing their target', async () => {
    await withTestEnvironment(async (fixture) => {
      const paths = getStatePaths(fixture.roots, 'global');
      const outside = join(fixture.temporaryRoot, 'outside-state');
      await mkdir(outside);
      const sentinel = join(outside, 'lock.json');
      await writeFile(sentinel, 'keep');
      await symlink(outside, paths.root);
      const store = new StateStore(paths);
      await expect(store.read()).rejects.toMatchObject({ code: 'INVALID_PATH' });
      await expect(store.write(createEmptyLock())).rejects.toMatchObject({ code: 'INVALID_PATH' });
      expect(await readFile(sentinel, 'utf8')).toBe('keep');
      await rm(paths.root);
      await mkdir(paths.root, { recursive: true });
      await symlink(outside, paths.lockPath);
      await expect(store.read()).rejects.toMatchObject({ code: 'INVALID_LOCK' });
      await expect(store.write(createEmptyLock())).rejects.toMatchObject({ code: 'INVALID_LOCK' });
      expect(await readFile(sentinel, 'utf8')).toBe('keep');
    });
  });
});
