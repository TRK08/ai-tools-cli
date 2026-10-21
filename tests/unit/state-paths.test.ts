import { access, cp, mkdir, readFile } from 'node:fs/promises';
import { symlink } from '../helpers/links.ts';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertSourceCompatible, sourceIdentityKey } from '../../src/state/identity.ts';
import {
  getSkillDirectory,
  getStatePaths,
  resolveConnectionPath,
  resolveSourcePath,
} from '../../src/state/paths.ts';
import { parseLockFile, serializeLockFile } from '../../src/state/schema.ts';
import { StateStore } from '../../src/state/store.ts';
import { createEmptyLock, type InstallationRecord, type LockFile } from '../../src/state/types.ts';
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
