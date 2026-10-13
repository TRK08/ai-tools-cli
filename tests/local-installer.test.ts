import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LocalInstaller, type LocalInstallerOptions } from '../src/installer/local.ts';
import { installerFileSystem } from '../src/installer/filesystem.ts';
import { prepareDirectory } from '../src/sources/directory.ts';
import { directorySourceFileSystem } from '../src/sources/filesystem.ts';
import { hashDirectory } from '../src/state/hash.ts';
import { getStatePaths, WORKSPACE_PREFIX, LOCK_TEMP_PREFIX } from '../src/state/paths.ts';
import { defaultStateFileIO, StateStore } from '../src/state/store.ts';
import { withTestEnvironment, type TestEnvironment } from './helpers/test-environment.js';

const skillText = '---\nname: demo\ndescription: Demo skill\n---\nOriginal\n';
async function setup(context: TestEnvironment) {
  const paths = getStatePaths(context.roots, 'project');
  const source = join(context.roots.cwd, 'demo');
  await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), skillText);
  return {
    paths,
    source,
    copy: join(paths.skillsDirectory, 'demo'),
    installer: new LocalInstaller(context),
    store: new StateStore(paths),
  };
}
async function absent(path: string) {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}
async function cleanWork(paths: ReturnType<typeof getStatePaths>) {
  await absent(paths.operationLockPath);
  expect((await readdir(paths.root)).filter((name) => name.startsWith(LOCK_TEMP_PREFIX))).toEqual(
    [],
  );
  const agents = await readdir(paths.agentsDirectory).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  });
  expect(agents.filter((name) => name.startsWith(WORKSPACE_PREFIX))).toEqual([]);
}
async function snapshot(fixture: Awaited<ReturnType<typeof setup>>) {
  return {
    hash: await hashDirectory(fixture.copy),
    lock: await readFile(fixture.paths.lockPath, 'utf8'),
  };
}
function failingStore(context: TestEnvironment, phase: 'write' | 'commit') {
  return new StateStore(getStatePaths(context.roots, 'project'), {
    ...defaultStateFileIO,
    ...(phase === 'write'
      ? { writeTemporaryFile: vi.fn().mockRejectedValue(new Error('lock write failure')) }
      : { rename: vi.fn().mockRejectedValue(new Error('lock commit failure')) }),
  });
}

describe('direct project Codex lifecycle', () => {
  it('stores one ordinary shared directory and root lock; clean repeats do not replace files', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      expect(await fixture.installer.add('./demo')).toMatchObject({
        status: 'success',
        name: 'demo',
      });
      const info = await lstat(fixture.copy);
      expect(info.isDirectory()).toBe(true);
      expect(info.isSymbolicLink()).toBe(false);
      expect(await fixture.installer.list()).toEqual([
        {
          name: 'demo',
          source: { kind: 'directory', path: 'demo' },
          version: null,
          policy: 'local',
          contentHash: await hashDirectory(fixture.source),
          agents: ['codex'],
          connections: [{ agent: 'codex', path: '.agents/skills/demo' }],
        },
      ]);
      const before = await snapshot(fixture);
      const lockInode = (await lstat(fixture.paths.lockPath)).ino;
      for (const force of [false, true])
        expect(await fixture.installer.add('./demo', force)).toMatchObject({ status: 'unchanged' });
      expect(await snapshot(fixture)).toEqual(before);
      expect((await lstat(fixture.copy)).ino).toBe(info.ino);
      expect((await lstat(fixture.paths.lockPath)).ino).toBe(lockInode);
      await cleanWork(fixture.paths);
    });
  });
  it('updates source resources once and reports affected agents before replacing', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await fixture.installer.add('./demo');
      await writeFile(join(fixture.source, 'new'), 'new');
      const report = vi.fn(() =>
        expect(() =>
          writeFileSync(join(fixture.copy, 'probe'), 'old copy still exists'),
        ).not.toThrow(),
      );
      // The report's probe is an external edit, so the final hash check protects it.
      await expect(new LocalInstaller(context, { report }).add('./demo')).rejects.toThrow(
        /local changes/,
      );
      expect(report).toHaveBeenCalledWith('Replacing demo; affected agents: codex.');
      await rm(join(fixture.copy, 'probe'));
      await fixture.installer.add('./demo');
      expect(await hashDirectory(fixture.copy)).toBe(await hashDirectory(fixture.source));
      expect(await fixture.installer.list()).toHaveLength(1);
      await cleanWork(fixture.paths);
    });
  });
  it.each(['edit', 'generated file', 'missing file', 'symlink', 'executable'])(
    'protects %s until force',
    async (change) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await fixture.installer.add('./demo');
        const skill = join(fixture.copy, 'SKILL.md');
        if (change === 'edit') await writeFile(skill, 'manual edits');
        if (change === 'generated file') await writeFile(join(fixture.copy, 'output'), 'output');
        if (change === 'missing file') await rm(skill);
        if (change === 'symlink') await symlink(fixture.source, join(fixture.copy, 'extra'));
        if (change === 'executable') await chmod(skill, 0o755);
        const before = await snapshot(fixture);
        const prepare = vi.fn(prepareDirectory);
        await expect(new LocalInstaller(context, { prepare }).add('./demo')).rejects.toThrow(
          /--force/,
        );
        expect(prepare).not.toHaveBeenCalled();
        expect(await snapshot(fixture)).toEqual(before);
        await fixture.installer.add('./demo', true);
        expect(await hashDirectory(fixture.copy)).toBe(await hashDirectory(fixture.source));
        await cleanWork(fixture.paths);
      });
    },
  );
  it.each([false, true])('handles edits during preparation with force=%s', async (force) => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await fixture.installer.add('./demo');
      await writeFile(join(fixture.source, 'new'), 'new');
      const before = await readFile(fixture.paths.lockPath, 'utf8');
      const prepare: typeof prepareDirectory = async (...args) => {
        const prepared = await prepareDirectory(...args);
        await writeFile(join(fixture.copy, 'SKILL.md'), 'late user edit');
        return prepared;
      };
      const operation = new LocalInstaller(context, { prepare }).add('./demo', force);
      if (force) {
        await operation;
        expect(await hashDirectory(fixture.copy)).toBe(await hashDirectory(fixture.source));
      } else {
        await expect(operation).rejects.toThrow(/local changes/);
        expect(await readFile(fixture.paths.lockPath, 'utf8')).toBe(before);
        expect(await readFile(join(fixture.copy, 'SKILL.md'), 'utf8')).toBe('late user edit');
      }
      await cleanWork(fixture.paths);
    });
  });
  it('records the baseline when forced contents already match the changed source', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await fixture.installer.add('./demo');
      for (const path of [fixture.copy, fixture.source])
        await writeFile(join(path, 'extra'), 'same');
      await expect(fixture.installer.add('./demo')).rejects.toThrow(/local changes/);
      expect(await fixture.installer.add('./demo', true)).toMatchObject({ status: 'success' });
      expect(await fixture.installer.add('./demo')).toMatchObject({ status: 'unchanged' });
      await cleanWork(fixture.paths);
    });
  });
  it.each(['copy', 'recorded connection'])('repairs a missing %s', async (missing) => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await fixture.installer.add('./demo');
      if (missing === 'copy') await rm(fixture.copy, { recursive: true });
      else
        await fixture.store.update((lock) => ({
          ...lock!,
          skills: { demo: { ...lock!.skills.demo!, connections: [] } },
        }));
      await fixture.installer.add('./demo');
      expect(await hashDirectory(fixture.copy)).toBe(await hashDirectory(fixture.source));
      expect((await fixture.installer.list())[0]?.connections).toHaveLength(1);
      await cleanWork(fixture.paths);
    });
  });
  it('rejects another source even with force and requires remove after a name change', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await fixture.installer.add('./demo');
      const before = await snapshot(fixture);
      await mkdir(join(context.roots.cwd, 'other'));
      await writeFile(join(context.roots.cwd, 'other', 'SKILL.md'), skillText);
      await expect(fixture.installer.add('./other', true)).rejects.toThrow(/different source/);
      await writeFile(
        join(fixture.source, 'SKILL.md'),
        skillText.replace('name: demo', 'name: renamed'),
      );
      await expect(fixture.installer.add('./demo')).rejects.toThrow(/name changed/);
      expect(await snapshot(fixture)).toEqual(before);
      await cleanWork(fixture.paths);
    });
  });
  it.each(['__proto__', 'constructor', 'ещё скилл'])(
    'preserves other records when removing %s',
    async (name) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await fixture.installer.add('./demo');
        const before = await snapshot(fixture);
        const other = join(context.roots.cwd, 'other');
        await mkdir(other);
        await writeFile(join(other, 'SKILL.md'), skillText.replace('name: demo', `name: ${name}`));
        await fixture.installer.add('./other');
        expect(await fixture.installer.list()).toHaveLength(2);
        await fixture.installer.remove(name);
        expect(await snapshot(fixture)).toEqual(before);
        await cleanWork(fixture.paths);
      });
    },
  );
  it.each(['directory', 'symlink', 'dangling symlink', 'file'])(
    'preserves a foreign %s even with force',
    async (kind) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await mkdir(fixture.paths.skillsDirectory, { recursive: true });
        if (kind === 'directory') {
          await mkdir(fixture.copy);
          await writeFile(join(fixture.copy, 'keep'), 'foreign');
        } else if (kind === 'file') await writeFile(fixture.copy, 'foreign');
        else await symlink(kind === 'symlink' ? fixture.source : '../missing', fixture.copy);
        const before = await hashDirectory(fixture.copy);
        await expect(fixture.installer.add('./demo', true)).rejects.toThrow(/Foreign shared-copy/);
        expect(await hashDirectory(fixture.copy)).toBe(before);
        expect(await fixture.store.read()).toBeNull();
        expect(await fixture.installer.remove('demo')).toMatchObject({ status: 'unchanged' });
        await cleanWork(fixture.paths);
      });
    },
  );
  it.each(['symlink', 'file'])(
    'refuses a registered copy replaced by a foreign %s',
    async (kind) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await fixture.installer.add('./demo');
        const lock = await readFile(fixture.paths.lockPath, 'utf8');
        await rm(fixture.copy, { recursive: true });
        if (kind === 'symlink') await symlink(fixture.source, fixture.copy);
        else await writeFile(fixture.copy, 'foreign');
        const before = await hashDirectory(fixture.copy);
        await expect(fixture.installer.add('./demo', true)).rejects.toThrow(/Foreign/);
        await expect(fixture.installer.remove('demo')).rejects.toThrow(/Foreign/);
        expect(await hashDirectory(fixture.copy)).toBe(before);
        expect(await readFile(fixture.paths.lockPath, 'utf8')).toBe(lock);
        await cleanWork(fixture.paths);
      });
    },
  );
  it.each(['.agents', '.agents/skills'])('refuses redirected parent %s', async (parent) => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      if (parent.endsWith('/skills')) await mkdir(fixture.paths.agentsDirectory);
      await symlink(context.roots.home, join(context.roots.cwd, parent));
      const before = await hashDirectory(context.roots.home);
      await expect(fixture.installer.add('./demo', true)).rejects.toThrow(/regular directory/);
      expect(await hashDirectory(context.roots.home)).toBe(before);
      await absent(fixture.paths.lockPath);
      await absent(fixture.paths.operationLockPath);
    });
  });
  it('refuses a foreign directory created during preparation', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      const prepare: typeof prepareDirectory = async (...args) => {
        const prepared = await prepareDirectory(...args);
        await mkdir(fixture.copy, { recursive: true });
        await writeFile(join(fixture.copy, 'keep'), 'foreign');
        return prepared;
      };
      await expect(new LocalInstaller(context, { prepare }).add('./demo', true)).rejects.toThrow(
        /Foreign/,
      );
      expect(await readFile(join(fixture.copy, 'keep'), 'utf8')).toBe('foreign');
      expect(await fixture.store.read()).toBeNull();
      await cleanWork(fixture.paths);
    });
  });
  it.each(['ordinary', 'modified', 'missing copy'])(
    'removes %s copy without source access or force',
    async (kind) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await fixture.installer.add('./demo');
        if (kind === 'modified') await writeFile(join(fixture.copy, 'SKILL.md'), 'manual edits');
        if (kind === 'missing copy') await rm(fixture.copy, { recursive: true });
        expect(await fixture.installer.remove('demo')).toMatchObject({ status: 'success' });
        await absent(fixture.copy);
        expect(await fixture.store.read()).toEqual({ version: 1, skills: {} });
        expect(await readFile(join(fixture.source, 'SKILL.md'), 'utf8')).toBe(skillText);
        expect(await fixture.installer.remove('demo')).toMatchObject({ status: 'unchanged' });
        await cleanWork(fixture.paths);
      });
    },
  );
  it('keeps Vercel lock and vitest bytes unchanged across add/list/remove', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      const vercelLock = join(context.roots.cwd, 'skills-lock.json');
      const vitest = join(fixture.paths.skillsDirectory, 'vitest');
      await writeFile(
        vercelLock,
        '{"version":1,"skills":{"vitest":{"source":"vercel","computedHash":"keep"}}}',
      );
      await mkdir(vitest, { recursive: true });
      await writeFile(join(vitest, 'SKILL.md'), 'foreign vitest');
      const before = {
        lock: await readFile(vercelLock, 'utf8'),
        hash: await hashDirectory(vitest),
      };
      await fixture.installer.add('./demo');
      expect((await fixture.installer.list()).map((record) => record.name)).toEqual(['demo']);
      await fixture.installer.remove('demo');
      expect({
        lock: await readFile(vercelLock, 'utf8'),
        hash: await hashDirectory(vitest),
      }).toEqual(before);
      await cleanWork(fixture.paths);
    });
  });
  it('lists only own state without creating directories', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      expect(await fixture.installer.list()).toEqual([]);
      await absent(fixture.paths.lockPath);
      await absent(fixture.paths.agentsDirectory);
    });
  });
  it('protects corrupt state, unsafe names and home scope before installation changes', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await expect(fixture.installer.remove('../demo')).rejects.toThrow(/Unsafe/);
      expect(
        () =>
          new LocalInstaller({
            ...context,
            roots: { cwd: context.roots.home, home: context.roots.home },
          }),
      ).toThrow(/home/);
      await fixture.installer.add('./demo');
      await writeFile(fixture.paths.lockPath, '{');
      const before = await snapshot(fixture);
      await expect(fixture.installer.add('./demo', true)).rejects.toThrow(/JSON/);
      await expect(fixture.installer.remove('demo')).rejects.toThrow(/JSON/);
      expect(await snapshot(fixture)).toEqual(before);
      await cleanWork(fixture.paths);
    });
  });
});

describe('handled failures and rollback', () => {
  it.each(['missing source', 'invalid metadata', 'read failure'])(
    'preserves installed bytes on %s',
    async (phase) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await fixture.installer.add('./demo');
        const before = await snapshot(fixture);
        const prepare: typeof prepareDirectory = (source, options) =>
          prepareDirectory(source, {
            ...options,
            fileSystem: {
              ...directorySourceFileSystem,
              readFile: vi.fn().mockRejectedValue(new Error('read failure')),
            },
          });
        if (phase === 'missing source') await rm(fixture.source, { recursive: true });
        if (phase === 'invalid metadata')
          await writeFile(join(fixture.source, 'SKILL.md'), 'invalid');
        await expect(
          new LocalInstaller(context, phase === 'read failure' ? { prepare } : {}).add('./demo'),
        ).rejects.toThrow();
        expect(await snapshot(fixture)).toEqual(before);
        await cleanWork(fixture.paths);
      });
    },
  );
  it.each(['backup', 'replacement', 'backup EXDEV', 'replacement EXDEV'])(
    'restores prior installation on %s failure',
    async (phase) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await fixture.installer.add('./demo');
        const before = await snapshot(fixture);
        await writeFile(join(fixture.source, 'new'), 'new');
        const rename = vi.fn(installerFileSystem.rename);
        if (phase.startsWith('replacement'))
          rename.mockImplementationOnce(installerFileSystem.rename);
        const failure = Object.assign(new Error('rename failure'), {
          code: phase.includes('EXDEV') ? 'EXDEV' : 'EIO',
        });
        rename.mockRejectedValueOnce(failure);
        await expect(
          new LocalInstaller(context, { fileSystem: { ...installerFileSystem, rename } }).add(
            './demo',
          ),
        ).rejects.toBe(failure);
        expect(await snapshot(fixture)).toEqual(before);
        await cleanWork(fixture.paths);
      });
    },
  );
  it.each(['write', 'commit'] as const)(
    'cleans a new installation after lock %s failure',
    async (phase) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await expect(
          new LocalInstaller(context, { store: failingStore(context, phase) }).add('./demo'),
        ).rejects.toThrow(/lock/);
        await absent(fixture.copy);
        expect(await fixture.store.read()).toBeNull();
        await cleanWork(fixture.paths);
      });
    },
  );
  it.each(['write', 'commit'] as const)(
    'restores forced user edits after lock %s failure',
    async (phase) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await fixture.installer.add('./demo');
        await writeFile(join(fixture.copy, 'SKILL.md'), 'manual edits');
        const before = await snapshot(fixture);
        await expect(
          new LocalInstaller(context, { store: failingStore(context, phase) }).add('./demo', true),
        ).rejects.toThrow(/lock/);
        expect(await snapshot(fixture)).toEqual(before);
        await cleanWork(fixture.paths);
      });
    },
  );
  it.each(['copy rename', 'lock write', 'lock commit'])(
    'restores remove after %s failure',
    async (phase) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await fixture.installer.add('./demo');
        await writeFile(join(fixture.copy, 'SKILL.md'), 'manual edits');
        const before = await snapshot(fixture);
        const options: LocalInstallerOptions = phase.startsWith('lock')
          ? { store: failingStore(context, phase === 'lock write' ? 'write' : 'commit') }
          : {
              fileSystem: {
                ...installerFileSystem,
                rename: vi.fn().mockRejectedValueOnce(new Error('rename failure')),
              },
            };
        await expect(new LocalInstaller(context, options).remove('demo')).rejects.toThrow();
        expect(await snapshot(fixture)).toEqual(before);
        await cleanWork(fixture.paths);
      });
    },
  );
  it.each(['success', 'rollback'])(
    'reports workspace cleanup failure after %s with consistent state',
    async (phase) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await fixture.installer.add('./demo');
        const before = await snapshot(fixture);
        await writeFile(join(fixture.source, 'new'), 'new');
        const options: LocalInstallerOptions = {
          fileSystem: {
            ...installerFileSystem,
            rm: vi.fn().mockRejectedValue(new Error('cleanup failure')),
          },
          ...(phase === 'rollback' ? { store: failingStore(context, 'commit') } : {}),
        };
        await expect(new LocalInstaller(context, options).add('./demo')).rejects.toThrow(
          /workspace cleanup failed/,
        );
        if (phase === 'success')
          expect((await fixture.store.read())?.skills.demo?.contentHash).toBe(
            await hashDirectory(fixture.copy),
          );
        else expect(await snapshot(fixture)).toEqual(before);
        const remaining = (await readdir(fixture.paths.agentsDirectory)).filter((name) =>
          name.startsWith(WORKSPACE_PREFIX),
        );
        expect(remaining).toHaveLength(1);
        await absent(fixture.paths.operationLockPath);
      });
    },
  );
  it('retains previous contents when rollback itself fails', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await fixture.installer.add('./demo');
      const oldHash = await hashDirectory(fixture.copy);
      await writeFile(join(fixture.source, 'new'), 'new');
      const rename = vi
        .fn(installerFileSystem.rename)
        .mockImplementationOnce(installerFileSystem.rename)
        .mockRejectedValueOnce(new Error('replacement failure'))
        .mockRejectedValueOnce(new Error('rollback failure'));
      await expect(
        new LocalInstaller(context, { fileSystem: { ...installerFileSystem, rename } }).add(
          './demo',
        ),
      ).rejects.toThrow(/rollback failed.*recovery files/);
      const directories = (await readdir(fixture.paths.agentsDirectory)).filter((name) =>
        name.startsWith(WORKSPACE_PREFIX),
      );
      expect(directories).toHaveLength(1);
      expect(
        await hashDirectory(join(fixture.paths.agentsDirectory, directories[0]!, 'previous')),
      ).toBe(oldHash);
      expect((await fixture.store.read())?.skills.demo?.contentHash).toBe(oldHash);
      await absent(fixture.paths.operationLockPath);
    });
  });
  it('blocks a second CLI writer during preparation and releases the lock afterward', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      const cli = new URL('../src/cli.ts', import.meta.url);
      const child = () =>
        spawnSync(
          process.execPath,
          ['--import', import.meta.resolve('tsx'), cli.pathname, 'add', './demo', '-a', 'codex'],
          {
            cwd: context.roots.cwd,
            env: { ...context.env, TSX_DISABLE_CACHE: '1' },
            encoding: 'utf8',
            timeout: 10000,
          },
        );
      const prepare: typeof prepareDirectory = async (...args) => {
        const blocked = child();
        expect(blocked.error).toBeUndefined();
        expect(blocked.status).toBe(1);
        expect(blocked.stderr).toContain('Scope is busy');
        return prepareDirectory(...args);
      };
      await new LocalInstaller(context, { prepare }).add('./demo');
      const retry = child();
      expect(retry.status).toBe(0);
      expect(retry.stdout).toContain('Unchanged');
      await cleanWork(fixture.paths);
    });
  });
});
