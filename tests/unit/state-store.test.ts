import { access, readFile, readdir, writeFile } from 'node:fs/promises';

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getStatePaths } from '../../src/state/paths.ts';

import { StateStore, defaultStateFileIO } from '../../src/state/store.ts';
import { type InstallationRecord, type LockFile } from '../../src/state/types.ts';
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

describe('atomic writes and scope locking', () => {
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
});
