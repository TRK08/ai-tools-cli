import { spawnSync } from 'node:child_process';
import {
  access,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { symlink } from './helpers/links.ts';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AGENTS, agentConnectionKind } from '../src/agents/catalog.ts';
import { assertSourceCompatible, sourceIdentityKey } from '../src/state/identity.ts';
import {
  getSkillDirectory,
  getStatePaths,
  resolveConnectionPath,
  resolveSourcePath,
} from '../src/state/paths.ts';
import { parseLockFile, serializeLockFile } from '../src/state/schema.ts';
import { StateStore, defaultStateFileIO, type StateTransaction } from '../src/state/store.ts';
import { createEmptyLock, type InstallationRecord, type LockFile } from '../src/state/types.ts';
import { withTestEnvironment, type TestEnvironment } from './helpers/test-environment.ts';

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

describe('state paths and portable schema', () => {
  it('rejects project scope in home before creating state, while global scope remains usable', async () => {
    await withTestEnvironment(async (fixture) => {
      const roots = { ...fixture.roots, cwd: fixture.roots.home };
      expect(() => getStatePaths(roots, 'project')).toThrowError(
        expect.objectContaining({
          code: 'PROJECT_IN_HOME',
          message: expect.stringContaining('--global'),
        }),
      );
      const global = new StateStore(getStatePaths(roots, 'global'));
      await expect(access(global.paths.root)).rejects.toMatchObject({ code: 'ENOENT' });
      await global.write(createEmptyLock());
      expect(await global.read()).toEqual(createEmptyLock());
    });
  });

  it('rejects a lexically equivalent home path after normalization', async () => {
    await withTestEnvironment(async (fixture) => {
      const roots = { ...fixture.roots, cwd: `${fixture.roots.home}/child/..` };
      expect(() => getStatePaths(roots, 'project')).toThrowError(
        expect.objectContaining({ code: 'PROJECT_IN_HOME' }),
      );
    });
  });

  it('rejects project reads/writes through a home symlink without creating or changing global state', async () => {
    await withTestEnvironment(async (fixture) => {
      const alias = join(fixture.temporaryRoot, 'home-alias');
      await symlink(fixture.roots.home, alias);
      const project = new StateStore(getStatePaths({ ...fixture.roots, cwd: alias }, 'project'));
      const global = new StateStore(getStatePaths(fixture.roots, 'global'));
      await expect(project.read()).rejects.toMatchObject({ code: 'PROJECT_IN_HOME' });
      await expect(project.write(createEmptyLock())).rejects.toMatchObject({
        code: 'PROJECT_IN_HOME',
      });
      await expect(access(global.paths.root)).rejects.toMatchObject({ code: 'ENOENT' });
      await global.write(createEmptyLock());
      const before = await readFile(global.paths.lockPath, 'utf8');
      await expect(project.read()).rejects.toMatchObject({ code: 'PROJECT_IN_HOME' });
      await expect(project.write(createEmptyLock())).rejects.toMatchObject({
        code: 'PROJECT_IN_HOME',
      });
      expect(await readFile(global.paths.lockPath, 'utf8')).toBe(before);
      expect(await global.read()).toEqual(createEmptyLock());
      await expect(access(global.paths.operationLockPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('uses exact cwd, including nested projects, and independent home without Git discovery', async () => {
    await withTestEnvironment(async (fixture) => {
      const roots = { ...fixture.roots, cwd: join(fixture.roots.cwd, 'packages', 'nested') };
      const project = getStatePaths(roots, 'project');
      const global = getStatePaths(roots, 'global');
      expect(project.root).toBe(roots.cwd);
      expect(project.skillsDirectory).toBe(join(roots.cwd, '.agents', 'skills'));
      expect(project.lockPath).toBe(join(roots.cwd, 'skills-installer-lock.json'));
      expect(global.root).toBe(join(roots.home, '.agents'));
      expect(global.lockPath).toBe(join(roots.home, '.agents', 'skills-installer-lock.json'));
      expect(project.lockPath).not.toBe(global.lockPath);
      expect(getSkillDirectory(project, 'demo')).toBe(join(project.skillsDirectory, 'demo'));
      expect(() => getStatePaths({ ...roots, cwd: 'relative' }, 'project')).toThrow();
      for (const name of ['..', '.', '../outside', '/absolute', 'bad\\name', 'bad\0name', '']) {
        expect(() => getSkillDirectory(project, name)).toThrow();
      }
    });
  });

  it('round-trips project sources/connections without absolute paths and relocates them', async () => {
    await withTestEnvironment(async (fixture) => {
      const paths = getStatePaths(fixture.roots, 'project');
      const store = new StateStore(paths);
      await mkdir(join(fixture.roots.cwd, 'sources', 'demo'), { recursive: true });
      await store.write(oneRecord(directoryRecord(fixture)));
      const content = await readFile(paths.lockPath, 'utf8');
      expect(content).not.toContain(fixture.temporaryRoot);
      const stored = await store.read();
      expect(stored?.skills.demo?.source).toEqual({ kind: 'directory', path: 'sources/demo' });
      expect(stored?.skills.demo?.connections).toEqual([
        { agent: 'codex', kind: 'direct' as const, path: '.agents/skills/demo' },
      ]);
      const movedCwd = join(fixture.temporaryRoot, 'moved-project');
      await cp(fixture.roots.cwd, movedCwd, { recursive: true });
      const movedPaths = getStatePaths({ ...fixture.roots, cwd: movedCwd }, 'project');
      const moved = await new StateStore(movedPaths).read();
      expect(moved).toEqual(stored);
      const source = moved?.skills.demo?.source;
      if (!source || source.kind === 'registry') throw new Error('Expected local source');
      expect(resolveSourcePath(source.path, movedPaths)).toBe(join(movedCwd, 'sources', 'demo'));
      await expect(access(resolveSourcePath(source.path, movedPaths))).resolves.toBeUndefined();
      expect(resolveConnectionPath('.agents/skills/demo', movedPaths)).toBe(
        join(movedCwd, '.agents', 'skills', 'demo'),
      );
    });
  });

  it('stores external local sources relatively and global sources/connections absolutely', async () => {
    await withTestEnvironment(async (fixture) => {
      const record = directoryRecord(fixture);
      const source = { kind: 'directory', path: join(fixture.temporaryRoot, 'external') } as const;
      const project = getStatePaths(fixture.roots, 'project');
      const global = getStatePaths(fixture.roots, 'global');
      const encoded = parseLockFile(
        JSON.parse(serializeLockFile(oneRecord({ ...record, source }), project)),
        project,
      );
      expect(encoded.skills.demo?.source).toEqual({ kind: 'directory', path: '../external' });
      const globalRecord = {
        ...record,
        source: { kind: 'directory' as const, path: './source' },
        connections: [
          {
            agent: 'codex' as const,
            kind: 'direct' as const,
            path: join(fixture.roots.home, '.agents', 'skills', 'demo'),
          },
        ],
      };
      const store = new StateStore(global);
      await store.write(oneRecord(globalRecord));
      const stored = await store.read();
      expect(stored?.skills.demo?.source).toEqual({
        kind: 'directory',
        path: join(fixture.roots.cwd, 'source'),
      });
      expect(stored?.skills.demo?.connections[0]?.path).toBe(
        join(fixture.roots.home, '.agents', 'skills', 'demo'),
      );
      expect(parseLockFile(JSON.parse(await readFile(global.lockPath, 'utf8')), global)).toEqual(
        stored,
      );
      await new StateStore(project).write(oneRecord(record));
      expect((await new StateStore(project).read())?.skills.demo?.source).not.toEqual(
        stored?.skills.demo?.source,
      );
    });
  });

  it('round-trips archive/registry records and ignores versions in registry identity', async () => {
    await withTestEnvironment(async (fixture) => {
      const paths = getStatePaths(fixture.roots, 'project');
      const base = directoryRecord(fixture);
      const archive: InstallationRecord = {
        ...base,
        name: 'archive',
        source: { kind: 'archive', path: join(fixture.roots.cwd, 'demo.tgz') },
        archiveHash: 'b'.repeat(64),
        connections: [],
      };
      const registry: InstallationRecord = {
        ...base,
        source: { kind: 'registry', registryUrl: 'http://localhost:8000/', slug: 'demo' },
        version: '1.2.3',
        policy: 'exact',
        archiveHash: 'c'.repeat(64),
      };
      const store = new StateStore(paths);
      await store.write({ version: 1, skills: { demo: registry, archive } });
      const stored = await store.read();
      expect(stored?.skills.archive?.source).toEqual({ kind: 'archive', path: 'demo.tgz' });
      expect(stored?.skills.demo).toMatchObject({
        version: '1.2.3',
        policy: 'exact',
        archiveHash: 'c'.repeat(64),
        source: { registryUrl: 'http://localhost:8000' },
      });
      await store.write({
        version: 1,
        skills: { ...stored?.skills, demo: { ...registry, version: '2.0.0', policy: 'latest' } },
      });
      expect((await store.read())?.skills.demo?.version).toBe('2.0.0');
      expect(sourceIdentityKey(registry.source, paths)).toBe(
        sourceIdentityKey(
          { kind: 'registry', registryUrl: 'http://LOCALHOST:8000', slug: 'demo' },
          paths,
        ),
      );
    });
  });

  it('rejects changed sources of an existing name until remove, including source kind and registry URL', async () => {
    await withTestEnvironment(async (fixture) => {
      const paths = getStatePaths(fixture.roots, 'project');
      const store = new StateStore(paths);
      const base = directoryRecord(fixture);
      await store.write(oneRecord(base));
      const previous = await readFile(paths.lockPath, 'utf8');
      await expect(
        store.write(oneRecord({ ...base, source: { kind: 'directory', path: 'different' } })),
      ).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' });
      expect(await readFile(paths.lockPath, 'utf8')).toBe(previous);
      const stored = await store.read();
      if (!stored) throw new Error('Expected existing lock');
      expect(() =>
        assertSourceCompatible(stored, 'demo', { kind: 'directory', path: 'sources/demo' }, paths),
      ).not.toThrow();
      expect(() =>
        assertSourceCompatible(stored, 'demo', { kind: 'archive', path: 'sources/demo' }, paths),
      ).toThrow();
      await store.write(createEmptyLock());
      const registry: InstallationRecord = {
        ...base,
        source: {
          kind: 'registry',
          registryUrl: 'https://registry.example.test/base',
          slug: 'demo',
        },
        version: '1.0.0',
        policy: 'latest',
        archiveHash: 'b'.repeat(64),
      };
      await store.write(oneRecord(registry));
      await expect(
        store.write(
          oneRecord({
            ...registry,
            source: { kind: 'registry', registryUrl: 'https://another.example.test', slug: 'demo' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' });
    });
  });

  it('sorts names/agents/connections and safely round-trips prototype-like names', async () => {
    await withTestEnvironment(async (fixture) => {
      const paths = getStatePaths(fixture.roots, 'project');
      const alpha = directoryRecord(fixture, 'alpha');
      const zeta = directoryRecord(fixture, 'zeta');
      const prototype = directoryRecord(fixture, '__proto__');
      const records = Object.fromEntries(
        [zeta, prototype, alpha].map((record) => [record.name, record]),
      );
      const first = serializeLockFile({ version: 1, skills: records }, paths);
      const second = serializeLockFile(
        {
          version: 1,
          skills: Object.fromEntries(
            [alpha, prototype, zeta].map((record) => [
              record.name,
              { ...record, agents: [...record.agents].reverse() },
            ]),
          ),
        },
        paths,
      );
      expect(first).toBe(second);
      const parsed = parseLockFile(JSON.parse(first), paths);
      expect(Object.hasOwn(parsed.skills, '__proto__')).toBe(true);
      expect(Object.keys(parsed.skills)).toEqual(['__proto__', 'alpha', 'zeta']);
    });
  });
});

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

describe('atomic writes and scope locking', () => {
  it('keeps an unconfirmed scope lock and closes the handle when obtaining owner stats fails', async () => {
    await withTestEnvironment(async (fixture) => {
      const paths = getStatePaths(fixture.roots, 'project');
      const probe = await open(join(fixture.temporaryRoot, 'probe'), 'wx');
      await probe.close();
      const failure = Object.assign(new Error('injected fstat failure'), { code: 'EIO' });
      const failedHandles: FileHandle[] = [];
      const statSpy = vi
        .spyOn(Object.getPrototypeOf(probe) as FileHandle, 'stat')
        .mockImplementationOnce(async function (this: FileHandle) {
          failedHandles.push(this);
          throw failure;
        });
      try {
        await expect(new StateStore(paths).write(createEmptyLock())).rejects.toBe(failure);
      } finally {
        statSpy.mockRestore();
      }
      expect(failedHandles[0]?.fd).toBe(-1);
      await expect(access(paths.operationLockPath)).resolves.toBeUndefined();
      await expect(new StateStore(paths).write(createEmptyLock())).rejects.toMatchObject({
        code: 'SCOPE_BUSY',
      });
    });
  });

  it.each(['write', 'rename'] as const)(
    'preserves old bytes and cleans partial temporary files on %s failure',
    async (failureAt) => {
      await withTestEnvironment(async (fixture) => {
        const paths = getStatePaths(fixture.roots, 'project');
        const store = new StateStore(paths);
        const record = directoryRecord(fixture);
        await store.write(oneRecord(record));
        const old = await readFile(paths.lockPath, 'utf8');
        const failure = new Error(`injected ${failureAt} failure`);
        const failing = new StateStore(paths, {
          ...defaultStateFileIO,
          ...(failureAt === 'write'
            ? {
                writeTemporaryFile: async (path: string, content: string) => {
                  await writeFile(path, content.slice(0, 10));
                  throw failure;
                },
              }
            : {
                rename: async () => {
                  throw failure;
                },
              }),
        });
        await expect(
          failing.write(oneRecord({ ...record, contentHash: 'b'.repeat(64) })),
        ).rejects.toBe(failure);
        expect(await readFile(paths.lockPath, 'utf8')).toBe(old);
        expect((await store.read())?.skills.demo?.contentHash).toBe(record.contentHash);
        expect(
          (await readdir(paths.root)).filter((name) => name.startsWith('.skills-installer-lock-')),
        ).toEqual([]);
        await expect(access(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      });
    },
  );

  it('cannot read a partial new lock before rename', async () => {
    await withTestEnvironment(async (fixture) => {
      const paths = getStatePaths(fixture.roots, 'project');
      const previous = oneRecord(directoryRecord(fixture));
      const store = new StateStore(paths);
      await store.write(previous);
      const writing = new StateStore(paths, {
        ...defaultStateFileIO,
        writeTemporaryFile: async (path, content) => {
          await writeFile(path, content.slice(0, 10));
          expect((await store.read())?.skills.demo?.contentHash).toBe('a'.repeat(64));
          await writeFile(path, content);
        },
      });
      await writing.write(oneRecord({ ...directoryRecord(fixture), contentHash: 'b'.repeat(64) }));
      expect((await store.read())?.skills.demo?.contentHash).toBe('b'.repeat(64));
    });
  });

  it('rejects concurrent writers, keeps other scopes available, and retries without losing records', async () => {
    await withTestEnvironment(async (fixture) => {
      const paths = getStatePaths(fixture.roots, 'project');
      const first = new StateStore(paths);
      const second = new StateStore(paths);
      let notifyEntered = () => {};
      const entered = new Promise<void>((resolve) => {
        notifyEntered = resolve;
      });
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = first.update(async (previous) => {
        notifyEntered();
        await released;
        return {
          version: 1,
          skills: { ...previous?.skills, alpha: directoryRecord(fixture, 'alpha') },
        };
      });
      try {
        await entered;
        await expect(
          second.update((previous) => ({
            version: 1,
            skills: { ...previous?.skills, beta: directoryRecord(fixture, 'beta') },
          })),
        ).rejects.toMatchObject({ code: 'SCOPE_BUSY' });
        const global = new StateStore(getStatePaths(fixture.roots, 'global'));
        await global.write(createEmptyLock());
        expect(await global.read()).toEqual(createEmptyLock());
      } finally {
        release();
        await pending;
      }
      await second.update((previous) => ({
        version: 1,
        skills: { ...previous?.skills, beta: directoryRecord(fixture, 'beta') },
      }));
      expect(Object.keys((await first.read())?.skills ?? {})).toEqual(['alpha', 'beta']);
      await expect(access(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('enforces the same scope lock across processes and releases it after callback errors', async () => {
    await withTestEnvironment(async (fixture) => {
      const paths = getStatePaths(fixture.roots, 'project');
      const store = new StateStore(paths);
      await store.write(oneRecord(directoryRecord(fixture, 'alpha')));
      const script = `import {StateStore} from ${JSON.stringify(new URL('../src/state/store.ts', import.meta.url).href)}; import {getStatePaths} from ${JSON.stringify(new URL('../src/state/paths.ts', import.meta.url).href)}; const store=new StateStore(getStatePaths(${JSON.stringify(fixture.roots)},'project')); try {await store.update(previous=>({version:1,skills:{...previous?.skills,beta:${JSON.stringify(directoryRecord(fixture, 'beta'))}}}));} catch(error){console.error(error.code);process.exitCode=1;}`;
      const child = () =>
        spawnSync(
          process.execPath,
          ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script],
          {
            cwd: fixture.roots.cwd,
            env: { ...fixture.env, TSX_DISABLE_CACHE: '1' },
            encoding: 'utf8',
            timeout: 10000,
          },
        );
      const failure = new Error('operation failed');
      await expect(
        store.transaction(async () => {
          const blocked = child();
          expect(blocked.error).toBeUndefined();
          expect(blocked.status).toBe(1);
          expect(blocked.stderr).toContain('SCOPE_BUSY');
          throw failure;
        }),
      ).rejects.toBe(failure);
      await expect(access(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const retry = child();
      expect(retry.error).toBeUndefined();
      expect(retry.status).toBe(0);
      expect(Object.keys((await store.read())?.skills ?? {})).toEqual(['alpha', 'beta']);
    });
  });

  it('rejects stale scope locks and prevents using an ended transaction', async () => {
    await withTestEnvironment(async (fixture) => {
      const paths = getStatePaths(fixture.roots, 'project');
      const store = new StateStore(paths);
      await mkdir(paths.root, { recursive: true });
      await writeFile(paths.operationLockPath, 'stale lock');
      await expect(store.write(createEmptyLock())).rejects.toMatchObject({ code: 'SCOPE_BUSY' });
      expect(await readFile(paths.operationLockPath, 'utf8')).toBe('stale lock');
      await rm(paths.operationLockPath);
      let ended: StateTransaction | undefined;
      await store.transaction(async (transaction) => {
        ended = transaction;
      });
      if (!ended) throw new Error('Expected transaction');
      await expect(ended.write(createEmptyLock())).rejects.toMatchObject({ code: 'SCOPE_BUSY' });
      await expect(access(paths.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
