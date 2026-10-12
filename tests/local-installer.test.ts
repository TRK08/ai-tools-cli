import { spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LocalInstaller, type LocalInstallerOptions } from '../src/installer/local.ts';
import { installerFileSystem } from '../src/installer/filesystem.ts';
import { prepareDirectory } from '../src/sources/directory.ts';
import { directorySourceFileSystem } from '../src/sources/filesystem.ts';
import { hashDirectory } from '../src/state/hash.ts';
import { getStatePaths } from '../src/state/paths.ts';
import { defaultStateFileIO, StateStore } from '../src/state/store.ts';
import { withTestEnvironment, type TestEnvironment } from './helpers/test-environment.js';

const skillText = '---\nname: demo\ndescription: Demo skill\n---\nOriginal\n';

async function setup(fixture: TestEnvironment) {
  const paths = getStatePaths(fixture.roots, 'project');
  const source = join(fixture.roots.cwd, 'demo');
  const copy = join(paths.skillsDirectory, 'demo');
  const link = join(fixture.roots.cwd, '.agents', 'skills', 'demo');
  await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), skillText);
  const installer = new LocalInstaller(fixture);
  const store = new StateStore(paths);
  return { paths, source, copy, link, installer, store };
}

async function absent(path: string) {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function cleanWork(paths: ReturnType<typeof getStatePaths>) {
  await absent(paths.operationLockPath);
  for (const directory of [paths.temporaryDirectory, paths.backupDirectory]) {
    const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    expect(entries).toEqual([]);
  }
}

async function snapshot(fixture: Awaited<ReturnType<typeof setup>>) {
  return {
    contentHash: await hashDirectory(fixture.copy),
    target: await readlink(fixture.link),
    lock: await readFile(fixture.paths.lockPath, 'utf8'),
  };
}

function failingStore(fixture: TestEnvironment, phase: 'write' | 'commit') {
  return new StateStore(getStatePaths(fixture.roots, 'project'), {
    ...defaultStateFileIO,
    ...(phase === 'write'
      ? { writeTemporaryFile: vi.fn().mockRejectedValue(new Error('lock write failure')) }
      : { rename: vi.fn().mockRejectedValue(new Error('lock commit failure')) }),
  });
}

describe('project Codex lifecycle', () => {
  it('stores one shared snapshot, a relative link and portable state; a clean repeat is a no-op', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      expect(await fixture.installer.add('./demo')).toEqual({ status: 'success', name: 'demo' });
      expect((await lstat(fixture.link)).isSymbolicLink()).toBe(true);
      expect(await readlink(fixture.link)).toBe('../../.skills-installer/skills/demo');
      expect(await readFile(join(fixture.link, 'SKILL.md'), 'utf8')).toBe(skillText);
      const records = await fixture.installer.list();
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual({
        name: 'demo',
        source: { kind: 'directory', path: 'demo' },
        version: null,
        policy: 'local',
        contentHash: await hashDirectory(fixture.source),
        agents: ['codex'],
        connections: [{ agent: 'codex', path: '.agents/skills/demo' }],
      });
      const before = await snapshot(fixture);
      const inode = (await lstat(fixture.copy)).ino;
      const lockInode = (await lstat(fixture.paths.lockPath)).ino;
      for (const force of [false, true]) {
        expect(await fixture.installer.add(fixture.source, force)).toEqual({
          status: 'unchanged',
          name: 'demo',
        });
      }
      expect(await snapshot(fixture)).toEqual(before);
      expect((await lstat(fixture.copy)).ino).toBe(inode);
      expect((await lstat(fixture.paths.lockPath)).ino).toBe(lockInode);
      await cleanWork(fixture.paths);
    });
  });

  it('updates the same source and reports affected agents before replacing', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await fixture.installer.add('./demo');
      await writeFile(join(fixture.source, 'new-resource'), 'new');
      const report = vi.fn(() => {
        // Presentation happens while the old copy is still in place.
        expect(report).toHaveBeenCalledWith('Replacing demo; affected agents: codex.');
      });
      expect(await new LocalInstaller(context, { report }).add('./demo')).toMatchObject({
        status: 'success',
      });
      expect(report).toHaveBeenCalledOnce();
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
        const installedSkill = join(fixture.copy, 'SKILL.md');
        if (change === 'edit') await writeFile(installedSkill, 'manual edits');
        if (change === 'generated file')
          await writeFile(join(fixture.copy, 'output'), 'script output');
        if (change === 'missing file') await rm(installedSkill);
        if (change === 'symlink') await symlink(fixture.source, join(fixture.copy, 'extra'));
        if (change === 'executable') {
          const { chmod } = await import('node:fs/promises');
          await chmod(installedSkill, 0o755);
        }
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

  it('detects edits made during long preparation and preserves the changed installation', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await fixture.installer.add('./demo');
      await writeFile(join(fixture.source, 'new-resource'), 'new source');
      const lockBefore = await readFile(fixture.paths.lockPath, 'utf8');
      const prepare: typeof prepareDirectory = async (...args) => {
        const source = await prepareDirectory(...args);
        await writeFile(join(fixture.copy, 'SKILL.md'), 'late user edit');
        return source;
      };
      await expect(new LocalInstaller(context, { prepare }).add('./demo')).rejects.toThrow(
        /local changes/,
      );
      expect(await readFile(join(fixture.copy, 'SKILL.md'), 'utf8')).toBe('late user edit');
      expect(await readFile(fixture.paths.lockPath, 'utf8')).toBe(lockBefore);
      expect(await readlink(fixture.link)).toBe('../../.skills-installer/skills/demo');
      await cleanWork(fixture.paths);
    });
  });

  it('repairs missing links and copies without duplicating state', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await fixture.installer.add('./demo');
      const inode = (await lstat(fixture.copy)).ino;
      await rm(fixture.link);
      await fixture.installer.add('./demo');
      expect((await lstat(fixture.copy)).ino).toBe(inode);
      await rm(fixture.copy, { recursive: true });
      await fixture.installer.add('./demo');
      expect(await hashDirectory(fixture.copy)).toBe(await hashDirectory(fixture.source));
      expect(await fixture.installer.list()).toHaveLength(1);
      await cleanWork(fixture.paths);
    });
  });

  it('records a forced replacement baseline when source and edited copy already match', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await fixture.installer.add('./demo');
      await writeFile(join(fixture.copy, 'extra'), 'same edits');
      await writeFile(join(fixture.source, 'extra'), 'same edits');
      await expect(fixture.installer.add('./demo')).rejects.toThrow(/local changes/);
      expect(await fixture.installer.add('./demo', true)).toMatchObject({ status: 'success' });
      expect((await fixture.store.read())?.skills.demo?.contentHash).toBe(
        await hashDirectory(fixture.source),
      );
      expect(await fixture.installer.add('./demo')).toMatchObject({ status: 'unchanged' });
      await cleanWork(fixture.paths);
    });
  });

  it.each(['__proto__', 'constructor', 'ещё скилл'])(
    'preserves unrelated records when installing and removing %s',
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
        expect(await readFile(join(other, 'SKILL.md'), 'utf8')).toContain(name);
        await cleanWork(fixture.paths);
      });
    },
  );

  it('rejects a foreign link that appears during preparation', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      const prepare: typeof prepareDirectory = async (...args) => {
        const prepared = await prepareDirectory(...args);
        await mkdir(dirname(fixture.link), { recursive: true });
        await symlink(fixture.source, fixture.link);
        return prepared;
      };
      await expect(new LocalInstaller(context, { prepare }).add('./demo', true)).rejects.toThrow(
        /Foreign Codex/,
      );
      expect(await readlink(fixture.link)).toBe(fixture.source);
      await absent(fixture.copy);
      expect(await fixture.store.read()).toBeNull();
      await cleanWork(fixture.paths);
    });
  });

  it('rechecks the replacement decision when forced contents change just before linking', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await fixture.installer.add('./demo');
      await rm(fixture.link);
      const mkdtemp = async (prefix: string) => {
        const backup = await installerFileSystem.mkdtemp(prefix);
        await writeFile(join(fixture.copy, 'SKILL.md'), 'late edits');
        return backup;
      };
      await new LocalInstaller(context, {
        fileSystem: { ...installerFileSystem, mkdtemp },
      }).add('./demo', true);
      expect(await hashDirectory(fixture.copy)).toBe(await hashDirectory(fixture.source));
      expect(await readFile(join(fixture.link, 'SKILL.md'), 'utf8')).toBe(skillText);
      await cleanWork(fixture.paths);
    });
  });

  it('rejects a different source even with force and prevents silent name changes', async () => {
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

  it.each(['directory', 'symlink', 'dangling symlink', 'unregistered managed-target link'])(
    'leaves a foreign %s unchanged with force',
    async (kind) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await mkdir(dirname(fixture.link), { recursive: true });
        if (kind === 'directory') {
          await mkdir(fixture.link);
          await writeFile(join(fixture.link, 'keep'), 'foreign');
        } else {
          await symlink(
            kind === 'symlink'
              ? fixture.source
              : kind === 'dangling symlink'
                ? '../missing'
                : '../../.skills-installer/skills/demo',
            fixture.link,
          );
        }
        await expect(fixture.installer.add('./demo', true)).rejects.toThrow(/Foreign Codex/);
        if (kind === 'directory')
          expect(await readFile(join(fixture.link, 'keep'), 'utf8')).toBe('foreign');
        else expect((await lstat(fixture.link)).isSymbolicLink()).toBe(true);
        await absent(fixture.copy);
        expect(await fixture.store.read()).toBeNull();
        await cleanWork(fixture.paths);
      });
    },
  );

  it.each(['directory', 'symlink'])(
    'keeps old copy/lock when a registered link becomes a foreign %s',
    async (kind) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await fixture.installer.add('./demo');
        const lockBefore = await readFile(fixture.paths.lockPath, 'utf8');
        const hashBefore = await hashDirectory(fixture.copy);
        await rm(fixture.link);
        if (kind === 'directory') await mkdir(fixture.link);
        else await symlink(fixture.source, fixture.link);
        await writeFile(join(fixture.source, 'new'), 'new');
        await expect(fixture.installer.add('./demo', true)).rejects.toThrow(/Foreign Codex/);
        await expect(fixture.installer.remove('demo')).rejects.toThrow(/Foreign Codex/);
        expect(await readFile(fixture.paths.lockPath, 'utf8')).toBe(lockBefore);
        expect(await hashDirectory(fixture.copy)).toBe(hashBefore);
        expect(await readFile(join(fixture.source, 'SKILL.md'), 'utf8')).toBe(skillText);
        await cleanWork(fixture.paths);
      });
    },
  );

  it.each([
    '.agents',
    '.agents/skills',
    '.skills-installer/skills',
    '.skills-installer/tmp',
    '.skills-installer/backups',
  ])('rejects redirected parent %s', async (parent) => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      const path = join(context.roots.cwd, parent);
      await mkdir(dirname(path), { recursive: true });
      await symlink(context.roots.home, path);
      const homeBefore = await readdir(context.roots.home);
      await expect(fixture.installer.add('./demo', true)).rejects.toThrow(/regular directory/);
      expect(await readdir(context.roots.home)).toEqual(homeBefore);
      expect((await lstat(path)).isSymbolicLink()).toBe(true);
      await absent(fixture.copy);
      await absent(fixture.paths.operationLockPath);
    });
  });

  it('rejects an unregistered shared directory rather than adopting it', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await mkdir(fixture.copy, { recursive: true });
      await writeFile(join(fixture.copy, 'keep'), 'foreign');
      await expect(fixture.installer.add('./demo', true)).rejects.toThrow(/Foreign shared-copy/);
      expect(await readFile(join(fixture.copy, 'keep'), 'utf8')).toBe('foreign');
      expect(await fixture.store.read()).toBeNull();
      await absent(fixture.link);
      await cleanWork(fixture.paths);
    });
  });

  it.each(['ordinary', 'modified', 'missing copy', 'missing link', 'missing both'])(
    'removes %s installation without force or source access',
    async (kind) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await fixture.installer.add('./demo');
        if (kind === 'modified') await writeFile(join(fixture.copy, 'SKILL.md'), 'manual edits');
        if (kind === 'missing copy' || kind === 'missing both')
          await rm(fixture.copy, { recursive: true });
        if (kind === 'missing link' || kind === 'missing both') await rm(fixture.link);
        expect(await fixture.installer.remove('demo')).toEqual({ status: 'success', name: 'demo' });
        await absent(fixture.copy);
        await absent(fixture.link);
        expect(await fixture.store.read()).toEqual({ version: 1, skills: {} });
        expect(await readFile(join(fixture.source, 'SKILL.md'), 'utf8')).toBe(skillText);
        expect(await fixture.installer.remove('demo')).toMatchObject({ status: 'unchanged' });
        await cleanWork(fixture.paths);
      });
    },
  );

  it('lists only own state, without scanning or creating directories', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await mkdir(dirname(fixture.link), { recursive: true });
      await symlink(fixture.source, fixture.link);
      expect(await fixture.installer.list()).toEqual([]);
      await absent(fixture.paths.root);
      expect(await fixture.installer.remove('demo')).toMatchObject({ status: 'unchanged' });
      expect(await readlink(fixture.link)).toBe(fixture.source);
    });
  });

  it('rejects unsafe names, corrupt lock and home scope before modifying installations', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await expect(fixture.installer.remove('../demo')).rejects.toThrow(/Unsafe/);
      await absent(fixture.paths.root);
      const homeInstaller = () =>
        new LocalInstaller({
          ...context,
          roots: { cwd: context.roots.home, home: context.roots.home },
        });
      expect(homeInstaller).toThrow(/home|Home|home directory/);
      await fixture.installer.add('./demo');
      await writeFile(fixture.paths.lockPath, '{');
      const before = await snapshot(fixture);
      await expect(fixture.installer.add('./demo', true)).rejects.toThrow(/JSON/);
      await expect(fixture.installer.remove('demo')).rejects.toThrow(/JSON/);
      await expect(fixture.installer.list()).rejects.toThrow(/JSON/);
      expect(await snapshot(fixture)).toEqual(before);
      await cleanWork(fixture.paths);
    });
  });
});

describe('handled failures and recovery', () => {
  it.each(['missing source', 'invalid metadata', 'read failure'])(
    'keeps old installation on %s',
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

  it.each(['new', 'existing'])(
    'rolls back %s installation when no connection succeeds',
    async (kind) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        let before: string | undefined;
        if (kind === 'existing') {
          await fixture.installer.add('./demo');
          await rm(fixture.link);
          before = await readFile(fixture.paths.lockPath, 'utf8');
          await writeFile(join(fixture.source, 'new'), 'new');
        }
        const fileSystem = {
          ...installerFileSystem,
          symlink: vi.fn().mockRejectedValue(new Error('link failure')),
        };
        await expect(new LocalInstaller(context, { fileSystem }).add('./demo')).rejects.toThrow(
          /link failure/,
        );
        await absent(fixture.link);
        if (kind === 'existing') {
          expect(await readFile(join(fixture.copy, 'SKILL.md'), 'utf8')).toBe(skillText);
          await absent(join(fixture.copy, 'new'));
          expect(await readFile(fixture.paths.lockPath, 'utf8')).toBe(before);
        } else {
          await absent(fixture.copy);
          expect(await fixture.store.read()).toBeNull();
        }
        await cleanWork(fixture.paths);
      });
    },
  );

  it.each(['backup', 'replacement'])(
    'restores files and state after %s rename failure',
    async (phase) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await fixture.installer.add('./demo');
        const before = await snapshot(fixture);
        await writeFile(join(fixture.source, 'new'), 'new');
        const rename = vi.fn(installerFileSystem.rename);
        if (phase === 'replacement') rename.mockImplementationOnce(installerFileSystem.rename);
        rename.mockRejectedValueOnce(new Error('rename failure'));
        await expect(
          new LocalInstaller(context, { fileSystem: { ...installerFileSystem, rename } }).add(
            './demo',
          ),
        ).rejects.toThrow(/rename failure/);
        expect(await snapshot(fixture)).toEqual(before);
        await cleanWork(fixture.paths);
      });
    },
  );

  it.each(['write', 'commit'] as const)(
    'rolls back new copy and link after lock %s failure',
    async (phase) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await expect(
          new LocalInstaller(context, { store: failingStore(context, phase) }).add('./demo'),
        ).rejects.toThrow(/lock/);
        await absent(fixture.copy);
        await absent(fixture.link);
        expect(await fixture.store.read()).toBeNull();
        await cleanWork(fixture.paths);
      });
    },
  );

  it.each(['write', 'commit'] as const)(
    'restores edited old contents after forced replacement and lock %s failure',
    async (phase) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await fixture.installer.add('./demo');
        await writeFile(join(fixture.copy, 'SKILL.md'), 'manual edits to recover');
        const before = await snapshot(fixture);
        await expect(
          new LocalInstaller(context, { store: failingStore(context, phase) }).add('./demo', true),
        ).rejects.toThrow(/lock/);
        expect(await snapshot(fixture)).toEqual(before);
        await cleanWork(fixture.paths);
      });
    },
  );

  it.each(['link rename', 'copy rename', 'lock write', 'lock commit'])(
    'rolls remove back after %s failure',
    async (phase) => {
      await withTestEnvironment(async (context) => {
        const fixture = await setup(context);
        await fixture.installer.add('./demo');
        await writeFile(join(fixture.copy, 'SKILL.md'), 'manual edits to recover');
        const before = await snapshot(fixture);
        const rename = vi.fn(installerFileSystem.rename);
        if (phase === 'copy rename') rename.mockImplementationOnce(installerFileSystem.rename);
        rename.mockRejectedValueOnce(new Error('rename failure'));
        const options: LocalInstallerOptions = phase.startsWith('lock')
          ? { store: failingStore(context, phase === 'lock write' ? 'write' : 'commit') }
          : { fileSystem: { ...installerFileSystem, rename } };
        await expect(new LocalInstaller(context, options).remove('demo')).rejects.toThrow();
        expect(await snapshot(fixture)).toEqual(before);
        await cleanWork(fixture.paths);
      });
    },
  );

  it('keeps committed state consistent and reports a failed backup cleanup', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      await fixture.installer.add('./demo');
      await writeFile(join(fixture.source, 'new'), 'new');
      const rmFailure = vi.fn().mockRejectedValue(new Error('cleanup failure'));
      await expect(
        new LocalInstaller(context, { fileSystem: { ...installerFileSystem, rm: rmFailure } }).add(
          './demo',
        ),
      ).rejects.toThrow(/committed.*cleanup/);
      expect(await hashDirectory(fixture.copy)).toBe(await hashDirectory(fixture.source));
      expect((await fixture.store.read())?.skills.demo?.contentHash).toBe(
        await hashDirectory(fixture.copy),
      );
      expect(await readlink(fixture.link)).toBe('../../.skills-installer/skills/demo');
      expect(await readdir(fixture.paths.backupDirectory)).toHaveLength(1);
      await absent(fixture.paths.operationLockPath);
    });
  });

  it('retains recovery files and reports both failures if rollback itself fails', async () => {
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
      const backups = await readdir(fixture.paths.backupDirectory);
      expect(backups).toHaveLength(1);
      expect(await hashDirectory(join(fixture.paths.backupDirectory, backups[0]!, 'skill'))).toBe(
        oldHash,
      );
      expect((await fixture.store.read())?.skills.demo?.contentHash).toBe(oldHash);
      await absent(fixture.paths.operationLockPath);
    });
  });

  it('holds the scope lock through preparation, rejects a competing CLI process, then releases it', async () => {
    await withTestEnvironment(async (context) => {
      const fixture = await setup(context);
      const cli = new URL('../src/cli.ts', import.meta.url);
      const child = (args: string[]) =>
        spawnSync(
          process.execPath,
          ['--import', import.meta.resolve('tsx'), cli.pathname, ...args],
          {
            cwd: context.roots.cwd,
            env: { ...context.env, TSX_DISABLE_CACHE: '1' },
            encoding: 'utf8',
            timeout: 10000,
          },
        );
      const prepare: typeof prepareDirectory = async (...args) => {
        const blocked = child(['add', './demo', '-a', 'codex']);
        expect(blocked.error).toBeUndefined();
        expect(blocked.status).toBe(1);
        expect(blocked.stderr).toContain('Scope is busy');
        expect(await fixture.store.read()).toBeNull();
        return prepareDirectory(...args);
      };
      await new LocalInstaller(context, { prepare }).add('./demo');
      const retry = child(['add', './demo', '-a', 'codex']);
      expect(retry.status).toBe(0);
      expect(retry.stdout).toContain('Unchanged');
      expect(await fixture.installer.list()).toHaveLength(1);
      await cleanWork(fixture.paths);
    });
  });
});
