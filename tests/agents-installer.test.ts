import {
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AGENTS, agentSkillsDirectory } from '../src/installer/agents.ts';
import { installerFileSystem } from '../src/installer/filesystem.ts';
import { Installer } from '../src/installer/installer.ts';
import type { AgentId, InstallationScope } from '../src/installer/types.ts';
import { prepareDirectory } from '../src/sources/directory.ts';
import { hashDirectory } from '../src/state/hash.ts';
import { getStatePaths, WORKSPACE_PREFIX } from '../src/state/paths.ts';
import { defaultStateFileIO, StateStore } from '../src/state/store.ts';
import { withTestEnvironment, type TestEnvironment } from './helpers/test-environment.js';

const text = '---\nname: demo\ndescription: Demo\n---\nv1\n';
const ids = AGENTS.map((agent) => agent.id);
async function fixture(context: TestEnvironment, scope: InstallationScope = 'project') {
  const source = join(context.roots.cwd, 'demo');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), text);
  const paths = getStatePaths(context.roots, scope);
  return {
    source,
    paths,
    copy: join(paths.skillsDirectory, 'demo'),
    installer: new Installer(context, { scope }),
    store: new StateStore(paths),
  };
}
async function absent(path: string) {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}
async function snapshot(copy: string, lock: string) {
  return { hash: await hashDirectory(copy), lock: await readFile(lock, 'utf8') };
}
async function clean(paths: ReturnType<typeof getStatePaths>) {
  await absent(paths.operationLockPath);
  expect(
    (await readdir(paths.agentsDirectory)).filter((name) => name.startsWith(WORKSPACE_PREFIX)),
  ).toEqual([]);
}

describe.each(['project', 'global'] as const)('%s agent lifecycle', (scope) => {
  it.each(ids)('connects %s to the shared directory and removes it', async (agent) => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context, scope);
      expect(await f.installer.add('./demo', false, [agent])).toMatchObject({ status: 'success' });
      const destination = join(agentSkillsDirectory(context, scope, agent), 'demo');
      if (destination === f.copy) expect((await lstat(destination)).isSymbolicLink()).toBe(false);
      else {
        const link = await readlink(destination);
        expect(resolve(dirname(destination), link)).toBe(f.copy);
        if (scope === 'project') expect(link.startsWith('/')).toBe(false);
      }
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe(text);
      const record = (await f.store.read())!.skills.demo!;
      expect(record.source).toEqual({
        kind: 'directory',
        path: scope === 'project' ? 'demo' : f.source,
      });
      expect(record.agents).toEqual([agent]);
      expect(await f.installer.remove('demo')).toMatchObject({ status: 'success' });
      await absent(destination);
      await absent(f.copy);
      expect(await readFile(join(f.source, 'SKILL.md'), 'utf8')).toBe(text);
      await clean(f.paths);
    });
  });

  it('shares one copy among all agents, merges repeats and filters list', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context, scope);
      await f.installer.add('./demo', false, ['codex']);
      await f.installer.add('./demo', false, [...ids, 'codex']);
      expect((await f.installer.list())[0]!.agents).toEqual([...ids].sort());
      expect((await f.installer.list(['pi']))[0]!.connections).toHaveLength(5);
      const before = await snapshot(f.copy, f.paths.lockPath);
      expect(await f.installer.add('./demo', false, ['pi'])).toMatchObject({ status: 'unchanged' });
      expect(await snapshot(f.copy, f.paths.lockPath)).toEqual(before);
      await writeFile(join(f.copy, 'manual'), 'user edits');
      await f.installer.remove('demo', ['codex']);
      expect((await f.store.read())!.skills.demo!.agents).not.toContain('codex');
      expect(await readFile(join(f.copy, 'manual'), 'utf8')).toBe('user edits');
      await f.installer.remove('demo', ['pi', 'claude-code']);
      expect((await f.store.read())!.skills.demo!.agents).toEqual(['cursor', 'opencode']);
      await f.installer.remove('demo');
      await absent(f.copy);
      await clean(f.paths);
    });
  });

  it('rolls back replacement if all requested symlink creations fail', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context, scope);
      await f.installer.add('./demo');
      const before = await snapshot(f.copy, f.paths.lockPath);
      await writeFile(join(f.source, 'SKILL.md'), text.replace('v1', 'v2'));
      const symlink = vi.fn().mockRejectedValue(new Error('connection failure'));
      const result = await new Installer(context, {
        scope,
        fileSystem: { ...installerFileSystem, symlink },
      }).add('./demo', false, ['claude-code']);
      expect(result.status).toBe('failed');
      expect(symlink).toHaveBeenCalledTimes(1);
      expect(await snapshot(f.copy, f.paths.lockPath)).toEqual(before);
      await clean(f.paths);
    });
  });
});

describe('connection failures and isolation', () => {
  it('rejects a global env destination inside shared storage before creating a cyclic link', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context, 'global');
      const custom = { ...context, env: { CLAUDE_CONFIG_DIR: join(f.copy, 'config') } };
      const result = await new Installer(custom, { scope: 'global' }).add('./demo', false, [
        'claude-code',
      ]);
      expect(result).toMatchObject({
        status: 'failed',
        errors: [expect.stringContaining('пересекается с общим хранилищем скиллов')],
      });
      await absent(f.copy);
      await absent(f.paths.lockPath);
      await clean(f.paths);
    });
  });

  it('recreates a missing managed link but refuses an unregistered link even with the same target', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context);
      await f.installer.add('./demo', false, ['codex', 'claude-code']);
      const link = join(context.roots.cwd, '.claude/skills/demo');
      await rm(link);
      expect(await f.installer.add('./demo', false, ['codex', 'claude-code'])).toMatchObject({
        status: 'success',
      });
      expect(await readFile(join(link, 'SKILL.md'), 'utf8')).toBe(text);
      await f.installer.remove('demo', ['claude-code']);
      const claude = join(context.roots.cwd, '.claude/skills/demo');
      await mkdir(dirname(claude), { recursive: true });
      await symlink('../../.agents/skills/demo', claude);
      const before = await snapshot(f.copy, f.paths.lockPath);
      expect(await f.installer.add('./demo', true, ['claude-code'])).toMatchObject({
        status: 'failed',
      });
      expect(await readlink(claude)).toBe('../../.agents/skills/demo');
      expect(await snapshot(f.copy, f.paths.lockPath)).toEqual(before);
    });
  });
  it('keeps local and global installations of the same name independent, including global from home', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context);
      await f.installer.add('./demo', false, ids);
      const before = await snapshot(f.copy, f.paths.lockPath);
      await writeFile(join(f.source, 'SKILL.md'), text.replace('v1', 'v2'));
      const globalContext = {
        ...context,
        roots: { cwd: context.roots.home, home: context.roots.home },
      };
      const global = new Installer(globalContext, { scope: 'global' });
      await global.add(f.source, false, ids);
      await global.remove('demo');
      expect(await snapshot(f.copy, f.paths.lockPath)).toEqual(before);
    });
  });

  it('uses exact default paths, trimmed env overrides and stored paths after env changes', async () => {
    await withTestEnvironment(async (context) => {
      const defaults = { ...context, env: {} };
      expect(ids.map((agent) => agentSkillsDirectory(defaults, 'global', agent))).toEqual([
        join(context.roots.home, '.claude/skills'),
        join(context.roots.home, '.agents/skills'),
        join(context.roots.home, '.agents/skills'),
        join(context.roots.home, '.agents/skills'),
        join(context.roots.home, '.agents/skills'),
      ]);
      const custom = {
        ...context,
        env: {
          CLAUDE_CONFIG_DIR: `  ${context.temporaryRoot}/custom-claude  `,
          XDG_CONFIG_HOME: `${context.temporaryRoot}/custom-config`,
        },
      };
      const f = await fixture(context, 'global');
      await new Installer(custom, { scope: 'global' }).add('./demo', false, [
        'claude-code',
        'opencode',
      ]);
      for (const agent of ['claude-code', 'opencode'] as const)
        expect(
          await readFile(
            join(agentSkillsDirectory(custom, 'global', agent), 'demo/SKILL.md'),
            'utf8',
          ),
        ).toBe(text);
      await f.installer.remove('demo');
      for (const agent of ['claude-code', 'opencode'] as const)
        await absent(join(agentSkillsDirectory(custom, 'global', agent), 'demo'));
      const blanks = { ...context, env: { CLAUDE_CONFIG_DIR: ' ', XDG_CONFIG_HOME: ' ' } };
      expect(agentSkillsDirectory(blanks, 'global', 'opencode')).toBe(
        agentSkillsDirectory(defaults, 'global', 'opencode'),
      );
      expect(agentSkillsDirectory(custom, 'project', 'claude-code')).toBe(
        join(context.roots.cwd, '.claude/skills'),
      );
    });
  });

  it('keeps Codex v1 and the identical lock when only a foreign Claude destination is requested for v2', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context);
      await f.installer.add('./demo');
      const before = await snapshot(f.copy, f.paths.lockPath);
      await writeFile(join(f.source, 'SKILL.md'), text.replace('v1', 'v2'));
      const foreign = join(context.roots.cwd, '.claude/skills/demo');
      await mkdir(foreign, { recursive: true });
      await writeFile(join(foreign, 'keep'), 'foreign');
      expect(await f.installer.add('./demo', true, ['claude-code'])).toMatchObject({
        status: 'failed',
      });
      expect(await snapshot(f.copy, f.paths.lockPath)).toEqual(before);
      expect(await readFile(join(foreign, 'keep'), 'utf8')).toBe('foreign');
      await clean(f.paths);
    });
  });

  it('preserves successful connections on partial add and updates the shared content for every prior agent', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context);
      await f.installer.add('./demo', false, ['pi']);
      await writeFile(join(f.source, 'SKILL.md'), text.replace('v1', 'v2'));
      await mkdir(join(context.roots.cwd, '.claude/skills/demo'), { recursive: true });
      const result = await f.installer.add('./demo', false, [
        'claude-code',
        'codex',
        'opencode',
        'cursor',
      ]);
      expect(result.status).toBe('partial');
      expect((await f.store.read())!.skills.demo!.agents).toEqual([
        'codex',
        'cursor',
        'opencode',
        'pi',
      ]);
      expect(await readFile(join(f.copy, 'SKILL.md'), 'utf8')).toContain('v2');
      expect(
        (await f.store.read())!.skills.demo!.connections.filter(
          (item) => item.path === '.agents/skills/demo',
        ),
      ).toHaveLength(4);
    });
  });

  it('cleans an unused new copy when every link creation fails', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context);
      const result = await new Installer(context, {
        fileSystem: {
          ...installerFileSystem,
          symlink: vi.fn().mockRejectedValue(new Error('denied')),
        },
      }).add('./demo', false, ['claude-code']);
      expect(result.status).toBe('failed');
      await absent(f.copy);
      await absent(f.paths.lockPath);
      await clean(f.paths);
    });
  });

  it('does not count an absent shared copy as a successful direct connection', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context);
      const lstatMissing = vi.fn(async (path: string) => {
        if (path === f.copy) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return installerFileSystem.lstat(path);
      });
      const result = await new Installer(context, {
        fileSystem: { ...installerFileSystem, lstat: lstatMissing },
      }).add('./demo', false, ['codex', 'cursor', 'opencode']);
      expect(result.status).toBe('failed');
      await absent(f.copy);
      await absent(f.paths.lockPath);
      await clean(f.paths);
    });
  });

  it.each(['directory', 'link', 'redirected parent'])(
    'keeps a foreign %s on remove and records only successful removals',
    async (kind) => {
      await withTestEnvironment(async (context) => {
        const f = await fixture(context);
        await f.installer.add('./demo', false, ['codex', 'claude-code']);
        const path = join(context.roots.cwd, '.claude/skills/demo');
        await rm(path);
        if (kind === 'directory') await mkdir(path);
        else if (kind === 'link') await symlink(f.source, path);
        else {
          await rm(dirname(path), { recursive: true });
          await symlink(context.roots.home, dirname(path));
        }
        expect(await f.installer.remove('demo')).toMatchObject({ status: 'partial' });
        expect((await f.store.read())!.skills.demo!.agents).toEqual(['claude-code']);
        expect(await readFile(join(f.copy, 'SKILL.md'), 'utf8')).toBe(text);
        if (kind !== 'redirected parent') expect(await lstat(path)).toBeDefined();
      });
    },
  );

  it('rolls back direct connections, shared files and the Claude link when state commit fails', async () => {
    await withTestEnvironment(async (context) => {
      const f = await fixture(context);
      await f.installer.add('./demo', false, ['codex', 'claude-code']);
      const link = join(context.roots.cwd, '.claude/skills/demo');
      const before = await snapshot(f.copy, f.paths.lockPath);
      const linkTarget = await readlink(link);
      const store = new StateStore(f.paths, {
        ...defaultStateFileIO,
        rename: vi.fn().mockRejectedValue(new Error('commit failed')),
      });
      await writeFile(join(f.source, 'SKILL.md'), text.replace('v1', 'v2'));
      const installer = new Installer(context, { store });
      await expect(installer.add('./demo', false, ['pi'])).rejects.toThrow('commit failed');
      expect(await readlink(link)).toBe(linkTarget);
      expect(await snapshot(f.copy, f.paths.lockPath)).toEqual(before);
      await expect(installer.remove('demo')).rejects.toThrow('commit failed');
      expect(await readlink(link)).toBe(linkTarget);
      expect(await snapshot(f.copy, f.paths.lockPath)).toEqual(before);
      await clean(f.paths);
    });
  });

  it('validates unknown/empty agents before preparation or filesystem changes', async () => {
    await withTestEnvironment(async (context) => {
      const prepare = vi.fn(prepareDirectory);
      const installer = new Installer(context, { prepare });
      await expect(installer.add('missing', false, ['unknown' as AgentId])).rejects.toThrow(
        'Неизвестный агент',
      );
      await expect(installer.add('missing', false, [])).rejects.toThrow('хотя бы одного');
      expect(prepare).not.toHaveBeenCalled();
      await absent(join(context.roots.cwd, '.agents'));
    });
  });
});
