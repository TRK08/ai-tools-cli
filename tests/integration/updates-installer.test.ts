import { readFileSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { symlink } from '../helpers/links.ts';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AGENTS } from '../../src/agents/catalog.ts';
import { agentSkillsDirectory } from '../../src/agents/resolve.ts';
import { installerFileSystem } from '../../src/installer/filesystem.ts';
import { Installer } from '../../src/installer/installer.ts';
import { hashDirectory } from '../../src/state/hash.ts';
import { getStatePaths, WORKSPACE_PREFIX } from '../../src/state/paths.ts';
import { defaultStateFileIO, StateStore } from '../../src/state/store.ts';
import { archiveBytes, skillText } from '../helpers/archive.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';
import { versionBytes, versionRegistry } from '../helpers/versions.ts';

const ids = AGENTS.map((agent) => agent.id);

describe.each(['project', 'global'] as const)('%s updates', (scope) => {
  it('uses the saved registry and all connections despite an agent filter and changed environment', async () => {
    const backend = versionRegistry();
    await withTestEnvironment(
      async (f) => {
        const paths = getStatePaths(f.roots, scope);
        const copy = join(paths.skillsDirectory, 'demo');
        const original = new Installer(f, { scope, registry: backend.url });
        await original.add('demo', false, ids);
        const before = (await original.list())[0]!;
        backend.current.demo = '2.0.0';
        const report = vi.fn(() =>
          expect(readFileSync(join(copy, 'SKILL.md'), 'utf8')).toContain('1.0.0'),
        );
        const installer = new Installer(
          {
            ...f,
            env: {
              ...f.env,
              SKILLS_API_URL: 'invalid',
              CLAUDE_CONFIG_DIR: join(f.roots.home, 'new-claude'),
              XDG_CONFIG_HOME: join(f.roots.home, 'new-config'),
            },
          },
          { scope, registry: 'invalid', report },
        );
        backend.requests.length = 0;
        const result = await installer.update('demo', false, ['codex', 'codex']);
        expect(result).toMatchObject({
          status: 'success',
          results: [
            {
              name: 'demo',
              status: 'success',
              changes: { content: true, connections: false, metadata: true },
            },
          ],
        });
        expect(backend.requests).toHaveLength(2);
        expect(report).toHaveBeenCalledExactlyOnceWith(
          'Замена demo; затрагиваемые агенты: claude-code, codex, cursor, opencode, pi.',
        );
        const after = (await installer.list())[0]!;
        expect(after.source).toEqual(before.source);
        expect(after.connections).toEqual(before.connections);
        expect(after.agents).toEqual(before.agents);
        expect(after.version).toBe('2.0.0');
        for (const connection of before.connections)
          expect(
            await readFile(
              join(
                scope === 'project' ? join(paths.cwd, connection.path) : connection.path,
                'SKILL.md',
              ),
              'utf8',
            ),
          ).toContain('2.0.0');
        expect(
          (await readdir(paths.agentsDirectory)).filter((n) => n.startsWith(WORKSPACE_PREFIX)),
        ).toEqual([]);
      },
      { http: backend.http },
    );
  });

  it('skips downloads, workspaces and writes on intact repeats, including force', async () => {
    const backend = versionRegistry();
    await withTestEnvironment(
      async (f) => {
        const paths = getStatePaths(f.roots, scope);
        const installer = new Installer(f, { scope, registry: backend.url });
        await installer.add('demo', false, ids);
        const copy = join(paths.skillsDirectory, 'demo');
        const before = {
          copy: await lstat(copy),
          lock: await lstat(paths.lockPath),
          hash: await hashDirectory(copy),
          bytes: await readFile(paths.lockPath),
        };
        const mkdtemp = vi.fn((prefix: string) => installerFileSystem.mkdtemp(prefix));
        const downloads = vi.fn();
        const repeated = new Installer(f, {
          scope,
          registry: backend.url,
          fileSystem: { ...installerFileSystem, mkdtemp },
          onDownload: downloads,
        });
        for (const force of [false, true]) {
          backend.requests.length = 0;
          expect((await repeated.update(undefined, force)).results[0]!.status).toBe('unchanged');
          expect(backend.requests).toEqual([`${backend.url}/api/v1/skills/demo/artifact`]);
          backend.requests.length = 0;
          expect((await repeated.add('demo', force, ids)).status).toBe('unchanged');
          expect(backend.requests).toHaveLength(1);
        }
        expect(mkdtemp).not.toHaveBeenCalled();
        expect(downloads).not.toHaveBeenCalled();
        expect(await readFile(paths.lockPath)).toEqual(before.bytes);
        expect((await lstat(paths.lockPath)).mtimeMs).toBe(before.lock.mtimeMs);
        expect((await lstat(copy)).ino).toBe(before.copy.ino);
        expect(await hashDirectory(copy)).toBe(before.hash);
      },
      { http: backend.http },
    );
  });

  it.each([false, true])(
    'skips exact and preserves even user edits with force=%s',
    async (force) => {
      const backend = versionRegistry();
      await withTestEnvironment(
        async (f) => {
          const paths = getStatePaths(f.roots, scope);
          const installer = new Installer(f, { scope, registry: backend.url });
          await installer.add('demo@1.0.0', false, ids);
          const copy = join(paths.skillsDirectory, 'demo');
          await writeFile(join(copy, 'manual'), 'keep');
          const before = { hash: await hashDirectory(copy), lock: await readFile(paths.lockPath) };
          backend.current.demo = '2.0.0';
          backend.http.mockClear();
          expect(await installer.update('demo', force)).toEqual({
            status: 'success',
            results: [{ status: 'pinned', name: 'demo', version: '1.0.0' }],
          });
          expect(backend.http).not.toHaveBeenCalled();
          expect({ hash: await hashDirectory(copy), lock: await readFile(paths.lockPath) }).toEqual(
            before,
          );
        },
        { http: backend.http },
      );
    },
  );

  it('downgrades and unpins through add, and changes only policy for the same version', async () => {
    const backend = versionRegistry();
    backend.current.demo = '2.0.0';
    await withTestEnvironment(
      async (f) => {
        const installer = new Installer(f, { scope, registry: backend.url });
        const paths = getStatePaths(f.roots, scope);
        await installer.add('demo', false, ids);
        expect((await installer.add('demo@1.0.0', false, ['codex'])).changes?.content).toBe(true);
        expect((await installer.list())[0]).toMatchObject({
          version: '1.0.0',
          policy: 'exact',
          agents: [...ids].sort(),
        });
        expect((await installer.update('demo', true)).results[0]!.status).toBe('pinned');
        await installer.add('demo', false, ['codex']);
        expect((await installer.list())[0]).toMatchObject({ version: '2.0.0', policy: 'latest' });
        const inode = (await lstat(join(paths.skillsDirectory, 'demo'))).ino;
        for (const source of ['demo@2.0.0', 'demo']) {
          backend.requests.length = 0;
          expect(await installer.add(source)).toMatchObject({
            status: 'success',
            changes: { content: false, connections: false, metadata: true },
          });
          expect(backend.requests).toHaveLength(1);
          expect((await lstat(join(paths.skillsDirectory, 'demo'))).ino).toBe(inode);
        }
        expect((await installer.list())[0]!.policy).toBe('latest');
      },
      { http: backend.http },
    );
  });

  it('adds and repairs connections without downloading an unchanged artifact', async () => {
    const backend = versionRegistry();
    await withTestEnvironment(
      async (f) => {
        const installer = new Installer(f, { scope, registry: backend.url });
        await installer.add('demo', false, ['codex']);
        backend.requests.length = 0;
        expect(await installer.add('demo', false, ['claude-code'])).toMatchObject({
          status: 'success',
          changes: { content: false, connections: true, metadata: false },
        });
        expect(backend.requests).toHaveLength(1);
        const link = join(agentSkillsDirectory(f, scope, 'claude-code'), 'demo');
        await rm(link, { recursive: true });
        backend.requests.length = 0;
        expect((await installer.update()).results[0]).toMatchObject({
          status: 'success',
          changes: { content: scope === 'project', connections: true, metadata: false },
        });
        expect(backend.requests).toHaveLength(1);
        expect((await lstat(link)).isSymbolicLink()).toBe(scope === 'global');
      },
      { http: backend.http },
    );
  });

  it.each(['missing', 'edited', 'symlink'])(
    'downloads unchanged metadata when the copy is %s; protects edits without force',
    async (change) => {
      const backend = versionRegistry();
      await withTestEnvironment(
        async (f) => {
          const installer = new Installer(f, { scope, registry: backend.url });
          const paths = getStatePaths(f.roots, scope);
          const copy = join(paths.skillsDirectory, 'demo');
          await installer.add('demo', false, ids);
          const expected = await hashDirectory(copy);
          if (change === 'missing') await rm(copy, { recursive: true });
          else if (change === 'edited') await writeFile(join(copy, 'manual'), 'edits');
          else await symlink(f.roots.cwd, join(copy, 'manual'));
          backend.requests.length = 0;
          if (change !== 'missing') {
            expect((await installer.update('demo')).status).toBe('failed');
            expect(backend.requests).toHaveLength(0);
          }
          expect((await installer.update('demo', change !== 'missing')).status).toBe('success');
          expect(backend.requests).toHaveLength(2);
          expect(await hashDirectory(copy)).toBe(expected);
          expect((await installer.list())[0]!.agents).toEqual([...ids].sort());
        },
        { http: backend.http },
      );
    },
  );

  it.each(['version', 'digest'])(
    'downloads a changed %s even when the other metadata is unchanged',
    async (change) => {
      const backend = versionRegistry();
      await withTestEnvironment(
        async (f) => {
          const installer = new Installer(f, { scope, registry: backend.url });
          await installer.add('demo');
          const paths = getStatePaths(f.roots, scope);
          const copy = join(paths.skillsDirectory, 'demo');
          const before = await lstat(copy);
          if (change === 'version') {
            backend.current.demo = '2.0.0';
            backend.archives.set('demo@2.0.0', versionBytes('demo', '1.0.0'));
          } else backend.archives.set('demo@1.0.0', versionBytes('demo', 'changed bytes'));
          backend.requests.length = 0;
          expect((await installer.update()).results[0]).toMatchObject({
            status: 'success',
            changes: { content: change === 'digest', metadata: true },
          });
          expect(backend.requests).toHaveLength(2);
          if (change === 'version') expect((await lstat(copy)).ino).toBe(before.ino);
        },
        { http: backend.http },
      );
    },
  );

  it.each(['directory', 'archive'] as const)(
    'refreshes the saved local %s and preserves missing sources',
    async (kind) => {
      await withTestEnvironment(async (f) => {
        const source = join(f.roots.cwd, kind === 'archive' ? 'input.tgz' : 'input');
        const set = async (text: string) => {
          if (kind === 'archive')
            await writeFile(source, archiveBytes([{ path: 'SKILL.md', contents: text }]));
          else {
            await mkdir(source, { recursive: true });
            await writeFile(join(source, 'SKILL.md'), text);
          }
        };
        await set(skillText);
        const installer = new Installer(f, { scope });
        await installer.add(source, false, ids);
        expect((await installer.update()).results[0]!.status).toBe('unchanged');
        await set(`${skillText}Next\n`);
        expect((await installer.update('demo', false, ['pi'])).results[0]!.status).toBe('success');
        const paths = getStatePaths(f.roots, scope);
        const before = {
          lock: await readFile(paths.lockPath),
          hash: await hashDirectory(join(paths.skillsDirectory, 'demo')),
        };
        await rm(source, { recursive: true });
        expect((await installer.update('demo', true)).status).toBe('failed');
        expect({
          lock: await readFile(paths.lockPath),
          hash: await hashDirectory(join(paths.skillsDirectory, 'demo')),
        }).toEqual(before);
        expect((await installer.list())[0]!.agents).toEqual([...ids].sort());
      });
    },
  );

  it('continues a batch after one source fails and filters records without changing other skills', async () => {
    const backend = versionRegistry();
    await withTestEnvironment(
      async (f) => {
        const installer = new Installer(f, { scope, registry: backend.url });
        await installer.add('demo', false, ['codex', 'pi']);
        await installer.add('other', false, ['pi']);
        backend.current.demo = backend.current.other = '2.0.0';
        expect(
          (await installer.update(undefined, false, ['codex'])).results.map(
            (result) => result.name,
          ),
        ).toEqual(['demo']);
        expect((await installer.list()).find((record) => record.name === 'other')!.version).toBe(
          '1.0.0',
        );
        backend.failures.add('demo');
        expect(await installer.update()).toMatchObject({
          status: 'failed',
          results: [
            { name: 'demo', status: 'failed' },
            { name: 'other', status: 'success' },
          ],
        });
        expect((await installer.list()).find((record) => record.name === 'other')!.version).toBe(
          '2.0.0',
        );
        expect((await installer.update('other', false, ['cursor'])).results).toEqual([]);
      },
      { http: backend.http },
    );
  });

  it('rejects foreign registered links; force cannot bypass them or a foreign shared copy', async () => {
    const backend = versionRegistry();
    await withTestEnvironment(
      async (f) => {
        const installer = new Installer(f, { scope, registry: backend.url });
        await installer.add('demo', false, ['codex', 'claude-code']);
        const link = join(agentSkillsDirectory(f, scope, 'claude-code'), 'demo');
        await rm(link, { recursive: true });
        await symlink(f.roots.cwd, link);
        backend.current.demo = '2.0.0';
        expect((await installer.update('demo', true, ['codex'])).results[0]).toMatchObject({
          status: 'failed',
          errors: [expect.stringContaining('Путь агента занят чужим объектом')],
        });
        expect((await installer.list())[0]).toMatchObject({
          version: '1.0.0',
          agents: ['claude-code', 'codex'],
        });
        const paths = getStatePaths(f.roots, scope);
        const copy = join(paths.skillsDirectory, 'demo');
        await rm(copy, { recursive: true });
        await symlink(f.roots.cwd, copy);
        backend.requests.length = 0;
        expect((await installer.update('demo', true)).results[0]).toMatchObject({
          status: 'failed',
          errors: [expect.stringContaining('Общий каталог занят чужим объектом')],
        });
        expect(backend.requests).toHaveLength(0);
      },
      { http: backend.http },
    );
  });

  it.each(['commit'])(
    'rolls back a forced replacement after %s failure and continues the batch',
    async (phase) => {
      const backend = versionRegistry();
      await withTestEnvironment(
        async (f) => {
          const paths = getStatePaths(f.roots, scope);
          const installer = new Installer(f, { scope, registry: backend.url });
          await installer.add('demo', false, ids);
          await installer.add('other', false, ['codex']);
          const copy = join(paths.skillsDirectory, 'demo');
          await writeFile(join(copy, 'manual'), 'keep after rollback');
          const before = {
            hash: await hashDirectory(copy),
            inode: (await lstat(copy)).ino,
            record: (await installer.list())[0],
          };
          backend.current.demo = backend.current.other = '2.0.0';
          const fail = () => {
            throw Object.assign(
              new Error(`${phase} failure`),
              phase === 'EXDEV' ? { code: 'EXDEV' } : {},
            );
          };
          const fs = { ...installerFileSystem, rename: vi.fn(installerFileSystem.rename) };
          if (['rename', 'EXDEV'].includes(phase))
            fs.rename
              .mockImplementationOnce(installerFileSystem.rename)
              .mockImplementationOnce(fail);
          const io = {
            ...defaultStateFileIO,
            writeTemporaryFile: vi.fn(defaultStateFileIO.writeTemporaryFile),
            rename: vi.fn(defaultStateFileIO.rename),
          };
          if (phase === 'write') io.writeTemporaryFile.mockImplementationOnce(fail);
          if (phase === 'commit') io.rename.mockImplementationOnce(fail);
          const failed = new Installer(f, {
            scope,
            registry: backend.url,
            fileSystem: fs,
            store: new StateStore(paths, io),
          });
          expect(await failed.update(undefined, true)).toMatchObject({
            status: 'failed',
            results: [
              { name: 'demo', status: 'failed' },
              { name: 'other', status: 'success' },
            ],
          });
          expect(await hashDirectory(copy)).toBe(before.hash);
          expect((await lstat(copy)).ino).toBe(before.inode);
          expect((await installer.list())[0]).toEqual(before.record);
          expect((await installer.list())[1]!.version).toBe('2.0.0');
          expect(
            (await readdir(paths.agentsDirectory)).filter((n) => n.startsWith(WORKSPACE_PREFIX)),
          ).toEqual([]);
          await expect(lstat(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
        },
        { http: backend.http },
      );
    },
  );

  it('rolls back when all registered links fail after replacing the copy', async () => {
    const backend = versionRegistry();
    await withTestEnvironment(
      async (f) => {
        const installer = new Installer(f, { scope, registry: backend.url });
        await installer.add('demo', false, ['claude-code']);
        const paths = getStatePaths(f.roots, scope);
        const before = await readFile(paths.lockPath);
        const copy = join(paths.skillsDirectory, 'demo');
        const hash = await hashDirectory(copy);
        await rm(join(agentSkillsDirectory(f, scope, 'claude-code'), 'demo'), { recursive: true });
        backend.current.demo = '2.0.0';
        const failed = new Installer(f, {
          scope,
          fileSystem: {
            ...installerFileSystem,
            [scope === 'project' ? 'cp' : 'symlink']: vi
              .fn()
              .mockRejectedValue(new Error('connection failure')),
          },
        });
        expect((await failed.update()).status).toBe('failed');
        expect(await readFile(paths.lockPath)).toEqual(before);
        expect(await hashDirectory(copy)).toBe(hash);
      },
      { http: backend.http },
    );
  });
});

it('protects a copy edited while registry metadata is being resolved, even with force', async () => {
  const backend = versionRegistry();
  await withTestEnvironment(
    async (f) => {
      const installer = new Installer(f, { registry: backend.url });
      await installer.add('demo');
      const paths = getStatePaths(f.roots, 'project');
      const original = backend.http.getMockImplementation()!;
      backend.http.mockImplementation(async (...args) => {
        const response = await original(...args);
        writeFileSync(join(paths.skillsDirectory, 'demo', 'manual'), 'concurrent edit');
        return response;
      });
      const before = await readFile(paths.lockPath);
      expect((await installer.update('demo', true)).results[0]).toMatchObject({
        status: 'failed',
        errors: [expect.stringContaining('изменился во время подготовки')],
      });
      expect(await readFile(paths.lockPath)).toEqual(before);
      expect(await readFile(join(paths.skillsDirectory, 'demo', 'manual'), 'utf8')).toBe(
        'concurrent edit',
      );
    },
    { http: backend.http },
  );
});

it('rejects corrupt state, unknown names and agents, and accepts an empty update', async () => {
  await withTestEnvironment(async (f) => {
    const installer = new Installer(f);
    expect(await installer.update()).toEqual({ status: 'success', results: [] });
    await expect(installer.update('missing')).rejects.toThrow(/не установлен/);
    await expect(installer.update(undefined, false, ['unknown' as never])).rejects.toThrow(
      /Неизвестный агент/,
    );
    const paths = getStatePaths(f.roots, 'project');
    await writeFile(paths.lockPath, '{broken');
    await expect(installer.update()).rejects.toThrow(/Некорректный JSON/);
  });
});
