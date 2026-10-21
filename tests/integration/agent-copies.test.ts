import { lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Installer } from '../../src/installer/installer.ts';
import { installerFileSystem } from '../../src/installer/filesystem.ts';
import type { AgentId } from '../../src/agents/catalog.ts';
import type { InstallerOptions } from '../../src/installer/types.ts';
import { prepareLocalSource } from '../../src/sources/local.ts';
import { hashDirectory } from '../../src/state/hash.ts';
import { getStatePaths, WORKSPACE_PREFIX } from '../../src/state/paths.ts';
import { defaultStateFileIO, StateStore } from '../../src/state/store.ts';
import { withTestEnvironment, type TestEnvironment } from '../helpers/test-environment.ts';
import { archiveBytes, skillText } from '../helpers/archive.ts';
import { versionRegistry } from '../helpers/versions.ts';

async function fixture(f: TestEnvironment, options: InstallerOptions = {}) {
  const source = join(f.roots.cwd, 'source');
  await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), skillText);
  await writeFile(join(source, 'binary'), Buffer.from([0, 255, 13, 10]));
  const paths = getStatePaths(f.roots, options.scope ?? 'project');
  const shared = join(paths.skillsDirectory, 'demo');
  const claude = join(
    options.scope === 'global' ? f.roots.home : f.roots.cwd,
    '.claude/skills/demo',
  );
  return { source, paths, shared, claude, installer: new Installer(f, options) };
}

async function state(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    lock: await readFile(f.paths.lockPath, 'utf8'),
    shared: await hashDirectory(f.shared),
    claude: await hashDirectory(f.claude),
    sharedInode: (await lstat(f.shared)).ino,
    claudeInode: (await lstat(f.claude)).ino,
    sharedFileInode: (await lstat(join(f.shared, 'SKILL.md'))).ino,
    claudeFileInode: (await lstat(join(f.claude, 'SKILL.md'))).ino,
  };
}

async function clean(paths: ReturnType<typeof getStatePaths>) {
  await expect(lstat(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(
    (await readdir(paths.agentsDirectory)).filter((name) => name.startsWith(WORKSPACE_PREFIX)),
  ).toEqual([]);
}

const selections: AgentId[][] = [['claude-code'], ['claude-code', 'codex'], ['codex']];
describe.each(['directory'] as readonly ('directory' | 'archive' | 'registry')[])(
  '%s copy layout',
  (kind) => {
    it.each(selections)(
      'uses ordinary project directories for %j from one snapshot',
      async (...agents) => {
        const backend = versionRegistry();
        await withTestEnvironment(
          async (context) => {
            const prepare = vi.fn(prepareLocalSource);
            const f = await fixture(context, { prepare, registry: backend.url });
            const archive = join(context.roots.cwd, 'source.tgz');
            await writeFile(archive, archiveBytes([{ path: 'SKILL.md', contents: skillText }]));
            const source = kind === 'registry' ? 'demo' : kind === 'archive' ? archive : f.source;
            expect(await f.installer.add(source, false, agents)).toMatchObject({
              status: 'success',
            });
            expect((await lstat(f.shared)).isDirectory()).toBe(true);
            if (agents.includes('claude-code')) {
              expect((await lstat(f.claude)).isSymbolicLink()).toBe(false);
              expect((await lstat(f.claude)).isDirectory()).toBe(true);
              expect(await hashDirectory(f.claude)).toBe(await hashDirectory(f.shared));
              const before = await state(f);
              expect(await f.installer.add(source, false, agents)).toMatchObject({
                status: 'unchanged',
              });
              expect(await state(f)).toEqual(before);
            } else await expect(lstat(f.claude)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(prepare).toHaveBeenCalledTimes(
              kind === 'registry' ? 0 : agents.includes('claude-code') ? 2 : 1,
            );
            if (kind === 'registry')
              expect(backend.requests.filter((url) => url.includes('/download/'))).toHaveLength(1);
            await clean(f.paths);
          },
          { http: backend.http },
        );
      },
    );
  },
);

describe('all managed copies share one content hash', () => {
  it.each(['shared', 'claude'] as const)(
    'protects edits in %s even when only Codex is requested and restores with force',
    async (copy) => {
      await withTestEnvironment(async (context) => {
        const f = await fixture(context);
        await f.installer.add(f.source, false, ['codex', 'claude-code']);
        await writeFile(join(f[copy], 'manual'), 'edits');
        const before = await state(f);
        await expect(f.installer.add(f.source, false, ['codex'])).rejects.toThrow(
          'изменён локально',
        );
        expect((await f.installer.update('demo', false, ['codex'])).results[0]).toMatchObject({
          status: 'failed',
        });
        expect(await state(f)).toEqual(before);
        expect(await f.installer.add(f.source, true, ['codex'])).toMatchObject({
          status: 'success',
        });
        expect(await hashDirectory(f.shared)).toBe(await hashDirectory(f.claude));
        await expect(lstat(join(f[copy], 'manual'))).rejects.toMatchObject({ code: 'ENOENT' });
        await clean(f.paths);
      });
    },
  );

  it('reuses shared registry bytes for Claude, checks policy-only repeats and avoids unnecessary workspace/writes', async () => {
    const backend = versionRegistry();
    await withTestEnvironment(
      async (context) => {
        const fs = {
          ...installerFileSystem,
          mkdtemp: vi.fn((prefix: string) => installerFileSystem.mkdtemp(prefix)),
          cp: vi.fn(installerFileSystem.cp),
          rename: vi.fn(installerFileSystem.rename),
        };
        const f = await fixture(context, { registry: backend.url, fileSystem: fs });
        await f.installer.add('demo@1.0.0', false, ['codex']);
        backend.requests.length = 0;
        await f.installer.add('demo@1.0.0', false, ['claude-code']);
        expect(backend.requests.filter((url) => url.includes('/download/'))).toHaveLength(0);
        const before = await state(f);
        fs.mkdtemp.mockClear();
        fs.cp.mockClear();
        fs.rename.mockClear();
        expect(await f.installer.add('demo', false, ['codex'])).toMatchObject({
          changes: { content: false, connections: false, metadata: true },
        });
        expect((await state(f)).sharedInode).toBe(before.sharedInode);
        expect((await state(f)).claudeInode).toBe(before.claudeInode);
        expect(fs.mkdtemp).not.toHaveBeenCalled();
        expect(fs.cp).not.toHaveBeenCalled();
        expect(fs.rename).not.toHaveBeenCalled();
        await writeFile(join(f.claude, 'manual'), 'edit');
        backend.requests.length = 0;
        await expect(f.installer.add('demo@1.0.0', false, ['codex'])).rejects.toThrow(
          'изменён локально',
        );
        expect(backend.requests).toHaveLength(0);
        expect(await f.installer.add('demo@1.0.0', true, ['codex'])).toMatchObject({
          changes: { content: true, metadata: true },
        });
        expect(backend.requests.filter((url) => url.includes('/download/'))).toHaveLength(0);
        expect(await hashDirectory(f.shared)).toBe(await hashDirectory(f.claude));
        await clean(f.paths);
      },
      { http: backend.http },
    );
  });

  it('updates both copies through a Codex filter, including a missing Claude copy', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context);
      await f.installer.add(f.source, false, ['codex', 'claude-code']);
      await rm(f.claude, { recursive: true });
      await writeFile(join(f.source, 'new'), 'version two');
      expect((await f.installer.update('demo', false, ['codex'])).results[0]).toMatchObject({
        status: 'success',
      });
      expect(await readFile(join(f.claude, 'new'), 'utf8')).toBe('version two');
      expect(await hashDirectory(f.shared)).toBe(await hashDirectory(f.claude));
    });
  });

  it('cancels while inspecting the Claude copy and leaves both installations untouched', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context);
      await f.installer.add(f.source, false, ['codex', 'claude-code']);
      const before = await state(f);
      const controller = new AbortController();
      const fs = {
        ...installerFileSystem,
        lstat: async (path: string) => {
          const stats = await installerFileSystem.lstat(path);
          if (path === f.claude) controller.abort(new Error('cancelled'));
          return stats;
        },
      };
      expect(
        await new Installer(context, { signal: controller.signal, fileSystem: fs }).add(
          f.source,
          true,
          ['codex'],
        ),
      ).toMatchObject({ status: 'skipped', reason: 'cancelled' });
      expect(await state(f)).toEqual(before);
      await clean(f.paths);
    });
  });

  it.each(['decline', 'cancel'] as const)(
    'leaves both copies intact on %s and cleans prepared staging',
    async (decision) => {
      await withTestEnvironment(async (context) => {
        const f = await fixture(context);
        await f.installer.add(f.source, false, ['codex', 'claude-code']);
        const before = await state(f);
        await writeFile(join(f.source, 'new'), 'new');
        expect(
          await new Installer(context, { reviewAdd: async () => decision }).add(f.source, false, [
            'codex',
          ]),
        ).toMatchObject({ status: 'skipped' });
        expect(await state(f)).toEqual(before);
        await clean(f.paths);
      });
    },
  );

  it.each(['add', 'update', 'metadata-only'] as const)(
    'rejects an edit to Claude after %s preview, including force',
    async (operation) => {
      const backend = versionRegistry();
      await withTestEnvironment(
        async (context) => {
          const f = await fixture(context, { registry: backend.url });
          const source = operation === 'metadata-only' ? 'demo@1.0.0' : f.source;
          await f.installer.add(source, false, ['codex', 'claude-code']);
          const before = await state(f);
          const review = async () => {
            await writeFile(join(f.claude, 'manual'), 'concurrent');
            return 'approve' as const;
          };
          const installer = new Installer(context, {
            registry: backend.url,
            reviewAdd: review,
            reviewUpdate: review,
          });
          if (operation === 'update')
            expect((await installer.update('demo', true, ['codex'])).results[0]).toMatchObject({
              status: 'failed',
            });
          else
            await expect(
              installer.add(operation === 'metadata-only' ? 'demo' : source, true, ['codex']),
            ).rejects.toThrow('изменился');
          expect(await readFile(f.paths.lockPath, 'utf8')).toBe(before.lock);
          expect(await hashDirectory(f.shared)).toBe(before.shared);
          expect(await readFile(join(f.claude, 'manual'), 'utf8')).toBe('concurrent');
          await clean(f.paths);
        },
        { http: backend.http },
      );
    },
  );
});

describe('copy transaction failures', () => {
  it.each([
    'staging',
    'staging-hash',
    'shared-backup',
    'shared-replacement',
    'claude-backup',
    'claude-replacement',
    'commit',
  ] as const)('restores both prior copies and lock after %s failure', async (phase) => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context);
      await f.installer.add(f.source, false, ['codex', 'claude-code']);
      const before = await state(f);
      await writeFile(join(f.source, 'new'), 'version two');
      const fs = {
        ...installerFileSystem,
        cp: vi.fn(async (...args: Parameters<typeof installerFileSystem.cp>) => {
          if (phase === 'staging') throw new Error('staging failed');
          await installerFileSystem.cp(...args);
          if (phase === 'staging-hash')
            await writeFile(join(String(args[1]), 'corrupt'), 'corrupt');
        }),
        rename: vi.fn(async (...args: Parameters<typeof installerFileSystem.rename>) => {
          const [from, to] = args.map(String);
          const fail =
            phase === 'shared-backup'
              ? from === f.shared
              : phase === 'shared-replacement'
                ? to === f.shared && !from!.endsWith('previous')
                : phase === 'claude-backup'
                  ? from === f.claude
                  : phase === 'claude-replacement'
                    ? to === f.claude && from!.includes('staging-')
                    : false;
          if (fail) throw new Error(phase + ' failed');
          await installerFileSystem.rename(...args);
        }),
      };
      const store =
        phase === 'commit'
          ? new StateStore(f.paths, {
              ...defaultStateFileIO,
              rename: vi.fn().mockRejectedValue(new Error('commit failed')),
            })
          : undefined;
      await expect(
        new Installer(context, { fileSystem: fs, ...(store ? { store } : {}) }).add(
          f.source,
          false,
          ['codex'],
        ),
      ).rejects.toThrow();
      expect(await state(f)).toEqual(before);
      await clean(f.paths);
    });
  });

  it.each(['staging', 'destination'] as const)(
    'allows partial only for a new Claude connection: %s failure',
    async (phase) => {
      await withTestEnvironment(async (context) => {
        const f = await fixture(context);
        await f.installer.add(f.source);
        await writeFile(join(f.source, 'new'), 'version two');
        const fs = {
          ...installerFileSystem,
          cp: async (...args: Parameters<typeof installerFileSystem.cp>) => {
            if (phase === 'staging') throw new Error('staging denied');
            await installerFileSystem.cp(...args);
          },
          rename: async (...args: Parameters<typeof installerFileSystem.rename>) => {
            if (String(args[1]) === f.claude) throw new Error('destination denied');
            await installerFileSystem.rename(...args);
          },
        };
        const installer = new Installer(context, { fileSystem: fs });
        expect(await installer.add(f.source, false, ['codex', 'claude-code'])).toMatchObject({
          status: 'partial',
        });
        expect((await installer.list())[0]!.agents).toEqual(['codex']);
        expect(await readFile(join(f.shared, 'new'), 'utf8')).toBe('version two');
        await expect(lstat(f.claude)).rejects.toMatchObject({ code: 'ENOENT' });
        await clean(f.paths);
      });
    },
  );

  it('retains committed copies after cleanup failure and uses bounded retries only for workspace', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context);
      await f.installer.add(f.source, false, ['claude-code', 'codex']);
      await writeFile(join(f.source, 'new'), 'new');
      const remove = vi.fn(installerFileSystem.rm).mockRejectedValue(new Error('busy workspace'));
      await expect(
        new Installer(context, { fileSystem: { ...installerFileSystem, rm: remove } }).add(
          f.source,
        ),
      ).rejects.toThrow('Операция завершена');
      expect(remove).toHaveBeenCalledWith(expect.stringContaining(WORKSPACE_PREFIX), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
      expect(await hashDirectory(f.shared)).toBe(await hashDirectory(f.claude));
      expect((await f.installer.list())[0]!.contentHash).toBe(await hashDirectory(f.shared));
      expect(await readFile(join(f.claude, 'new'), 'utf8')).toBe('new');
    });
  });

  it('keeps recovery backups and both causes if rollback of the second copy fails', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context);
      await f.installer.add(f.source, false, ['codex', 'claude-code']);
      await writeFile(join(f.source, 'new'), 'new');
      const fs = {
        ...installerFileSystem,
        rename: async (...args: Parameters<typeof installerFileSystem.rename>) => {
          if (String(args[0]) === f.claude && String(args[1]).includes('staging-'))
            throw new Error('rollback failed');
          await installerFileSystem.rename(...args);
        },
      };
      const store = new StateStore(f.paths, {
        ...defaultStateFileIO,
        rename: vi.fn().mockRejectedValue(new Error('commit failed')),
      });
      const failure = await new Installer(context, { fileSystem: fs, store })
        .add(f.source)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('файлы для восстановления');
      expect((failure as Error).cause).toBeInstanceOf(AggregateError);
      expect(
        ((failure as Error).cause as AggregateError).errors.map((error: Error) => error.message),
      ).toEqual(expect.arrayContaining(['commit failed', 'rollback failed']));
      expect(
        (await readdir(f.paths.agentsDirectory)).some((name) => name.startsWith(WORKSPACE_PREFIX)),
      ).toBe(true);
    });
  });
});

describe('removal of copies and global links', () => {
  it.each(['claude-code', 'codex'] as const)(
    'removes %s first and the last copy afterward, including manual edits',
    async (agent) => {
      await withTestEnvironment(async (context) => {
        const f = await fixture(context);
        await f.installer.add(f.source, false, ['codex', 'claude-code']);
        await writeFile(join(f.claude, 'manual'), 'manual');
        await f.installer.remove('demo', [agent]);
        expect((await lstat(f.shared)).isDirectory()).toBe(true);
        if (agent === 'claude-code')
          await expect(lstat(f.claude)).rejects.toMatchObject({ code: 'ENOENT' });
        else expect(await readFile(join(f.claude, 'manual'), 'utf8')).toBe('manual');
        await f.installer.remove('demo');
        await expect(lstat(f.shared)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(lstat(f.claude)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(f.source, 'SKILL.md'), 'utf8')).toBe(skillText);
      });
    },
  );

  it('removes an absent registered copy without touching the shared one', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context);
      await f.installer.add(f.source, false, ['codex', 'claude-code']);
      await rm(f.claude, { recursive: true });
      expect(await f.installer.remove('demo', ['claude-code'])).toMatchObject({
        status: 'success',
      });
      expect((await f.installer.list())[0]!.agents).toEqual(['codex']);
      expect((await lstat(f.shared)).isDirectory()).toBe(true);
    });
  });

  it.each([false, true])(
    'unlinks a global env path without rename across volumes, rollback=%j',
    async (rollback) => {
      await withTestEnvironment(async (context) => {
        const custom = {
          ...context,
          env: { CLAUDE_CONFIG_DIR: join(context.temporaryRoot, 'external-volume') },
        };
        const f = await fixture(custom, { scope: 'global' });
        await f.installer.add(f.source, false, ['codex', 'claude-code']);
        const link = join(custom.env.CLAUDE_CONFIG_DIR, 'skills/demo');
        const target = await readlink(link);
        const lock = await readFile(f.paths.lockPath);
        const rename = vi.fn(async (...args: Parameters<typeof installerFileSystem.rename>) => {
          if (String(args[0]) === link || String(args[1]) === link)
            throw Object.assign(new Error('cross volume'), { code: 'EXDEV' });
          await installerFileSystem.rename(...args);
        });
        const store = rollback
          ? new StateStore(f.paths, {
              ...defaultStateFileIO,
              rename: vi.fn().mockRejectedValue(new Error('commit failed')),
            })
          : undefined;
        const installer = new Installer(context, {
          scope: 'global',
          fileSystem: { ...installerFileSystem, rename },
          ...(store ? { store } : {}),
        });
        if (rollback) {
          await expect(installer.remove('demo', ['claude-code'])).rejects.toThrow('commit failed');
          expect(await readlink(link)).toBe(target);
          expect(await readFile(f.paths.lockPath)).toEqual(lock);
        } else {
          await installer.remove('demo', ['claude-code']);
          await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
        }
        expect(rename).not.toHaveBeenCalled();
        expect(await readFile(join(f.shared, 'SKILL.md'), 'utf8')).toBe(skillText);
        await clean(f.paths);
      });
    },
  );

  it('removes a dangling owned global link without reading or deleting its target', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context, { scope: 'global' });
      await f.installer.add(f.source, false, ['claude-code']);
      await rm(f.shared, { recursive: true });
      expect(await f.installer.remove('demo')).toMatchObject({ status: 'success' });
      await expect(lstat(f.claude)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await f.installer.list()).toEqual([]);
    });
  });
});
