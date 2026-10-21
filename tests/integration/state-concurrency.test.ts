import { spawnSync } from 'node:child_process';
import { access, mkdir, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';

import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { getStatePaths } from '../../src/state/paths.ts';

import { StateStore, type StateTransaction } from '../../src/state/store.ts';
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
it('enforces the same scope lock across processes and releases it after callback errors', async () => {
  await withTestEnvironment(async (fixture) => {
    const paths = getStatePaths(fixture.roots, 'project');
    const store = new StateStore(paths);
    await store.write(oneRecord(directoryRecord(fixture, 'alpha')));
    const script = `import {StateStore} from ${JSON.stringify(new URL('../../src/state/store.ts', import.meta.url).href)}; import {getStatePaths} from ${JSON.stringify(new URL('../../src/state/paths.ts', import.meta.url).href)}; const store=new StateStore(getStatePaths(${JSON.stringify(fixture.roots)},'project')); try {await store.update(previous=>({version:1,skills:{...previous?.skills,beta:${JSON.stringify(directoryRecord(fixture, 'beta'))}}}));} catch(error){console.error(error.code);process.exitCode=1;}`;
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
