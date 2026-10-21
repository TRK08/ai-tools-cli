import { describe, expect, it } from 'vitest';
import { AGENTS } from '../../src/agents/catalog.ts';
import { agentSkillsDirectory, parseAgents } from '../../src/agents/resolve.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';
import { join } from 'node:path';

describe('agent catalog', () => {
  it.each(['project', 'global'] as const)(
    'maps four direct readers to one %s directory and Claude to its own root',
    async (scope) => {
      await withTestEnvironment(async (context) => {
        const root = scope === 'project' ? context.roots.cwd : context.roots.home;
        for (const id of ['codex', 'opencode', 'cursor', 'pi'] as const)
          expect(agentSkillsDirectory(context, scope, id)).toBe(join(root, '.agents/skills'));
        expect(agentSkillsDirectory(context, scope, 'claude-code')).toBe(
          join(root, '.claude/skills'),
        );
        expect(AGENTS.map((agent) => agent.id).toSorted()).toEqual([
          'claude-code',
          'codex',
          'cursor',
          'opencode',
          'pi',
        ]);
      });
    },
  );
  it('deduplicates explicit agents and rejects unknown IDs', () => {
    expect(parseAgents(['pi', 'codex', 'pi'])).toEqual(['pi', 'codex']);
    expect(() => parseAgents(['unknown'])).toThrow('Неизвестный агент');
  });
});
