import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Installer } from '../src/installer/installer.ts';
import { agentSkillsDirectory } from '../src/installer/agents.ts';
import { getStatePaths, portableConnectionPath } from '../src/state/paths.ts';
import { withTestEnvironment } from './helpers/test-environment.ts';

const sharedAgents = ['codex', 'opencode', 'cursor', 'pi'] as const;
const content = '---\nname: demo\ndescription: Demo\n---\nv1\n';

describe.each(['project', 'global'] as const)('%s shared agents', (scope) => {
  it('installs four direct connections to one copy without agent-specific directories', async () =>
    withTestEnvironment(async (context) => {
      const source = join(context.roots.cwd, 'source');
      await mkdir(source);
      await writeFile(join(source, 'SKILL.md'), content);
      const paths = getStatePaths(context.roots, scope);
      const installer = new Installer(context, { scope });
      expect(await installer.add(source, false, sharedAgents)).toMatchObject({ status: 'success' });
      const shared = join(paths.skillsDirectory, 'demo');
      const record = (await installer.list())[0]!;
      expect(record.connections).toHaveLength(4);
      expect(new Set(record.connections.map((entry) => entry.path))).toEqual(
        new Set([portableConnectionPath(shared, paths)]),
      );
      expect((await lstat(shared)).isSymbolicLink()).toBe(false);
      for (const agent of sharedAgents)
        expect(agentSkillsDirectory(context, scope, agent)).toBe(paths.skillsDirectory);
      for (const directory of [
        '.pi/skills',
        '.pi/agent/skills',
        '.cursor/skills',
        '.claude/skills',
        '.config/opencode/skills',
      ])
        await expect(
          lstat(join(scope === 'project' ? context.roots.cwd : context.roots.home, directory)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      await installer.add(source, false, ['claude-code']);
      const claude = join(agentSkillsDirectory(context, scope, 'claude-code'), 'demo');
      expect((await lstat(claude)).isSymbolicLink()).toBe(true);
      await installer.remove('demo', sharedAgents);
      expect(await readFile(join(claude, 'SKILL.md'), 'utf8')).toBe(content);
      await installer.remove('demo', ['claude-code']);
      await expect(lstat(shared)).rejects.toMatchObject({ code: 'ENOENT' });
    }));
});
