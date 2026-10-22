import { describe, expect, it, vi } from 'vitest';
import { AGENTS } from '@/agents/catalog';
import { agentSkillsDirectory } from '@/agents/resolve';
import { preparationOptions } from '@/installer/source';
import { getStatePaths } from '@/state/paths';
import type { RuntimeContext } from '@/runtime';
import type { AgentDefinition } from '@/agents/catalog';

vi.mock('@/paths/native-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/paths/native-path')>();
  const { win32 } = await import('node:path');
  return { ...actual, ...actual.createPathOperations(win32) };
});

vi.mock('@/agents/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/catalog')>();
  return {
    ...actual,
    AGENTS: [
      {
        id: 'example-agent',
        label: 'Example agent',
        helpOrder: 0,
        project: {
          kind: 'copy',
          directory: () => 'C:\\project\\.example\\skills',
        },
        global: {
          kind: 'link',
          directory: () => 'C:\\home\\.example\\skills',
          environment: { name: 'EXAMPLE_CONFIG_DIR', suffix: ['extensions', 'skills'] },
        },
      },
    ] as const satisfies readonly AgentDefinition[],
  };
});

const context: RuntimeContext = {
  roots: { cwd: 'C:\\project', home: 'C:\\home' },
  env: {},
  http: async () => {
    throw new Error('HTTP is disabled.');
  },
};
const agent = AGENTS[0]!.id;

describe('catalog-driven agent configuration', () => {
  it.each([
    ['profiles\\custom', 'C:\\project\\profiles\\custom\\extensions\\skills'],
    ['D:\\custom', 'D:\\custom\\extensions\\skills'],
  ])(
    'resolves the declared environment root %s for an additional agent',
    (configured, expected) => {
      expect(
        agentSkillsDirectory(
          { ...context, env: { EXAMPLE_CONFIG_DIR: ` ${configured} ` } },
          'global',
          agent,
        ),
      ).toBe(expected);
    },
  );

  it.each([undefined, '', '   '])('uses the default directory for a blank override %j', (value) => {
    expect(
      agentSkillsDirectory({ ...context, env: { EXAMPLE_CONFIG_DIR: value } }, 'global', agent),
    ).toBe('C:\\home\\.example\\skills');
  });

  it('applies environment metadata only in its declared scope', () => {
    expect(
      agentSkillsDirectory(
        { ...context, env: { EXAMPLE_CONFIG_DIR: 'D:ambiguous' } },
        'project',
        agent,
      ),
    ).toBe('C:\\project\\.example\\skills');
  });

  it('rejects an ambiguous environment path before it becomes an absolute destination', () => {
    expect(() =>
      agentSkillsDirectory(
        { ...context, env: { EXAMPLE_CONFIG_DIR: 'D:ambiguous' } },
        'global',
        agent,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PATH' }));
  });

  it('excludes default and configured agent directories from source preparation', () => {
    const custom = { ...context, env: { EXAMPLE_CONFIG_DIR: 'D:\\custom' } };
    const options = preparationOptions(
      custom,
      getStatePaths(context.roots, 'global'),
      'C:\\workspace',
    );
    expect(options.excludedPaths).toEqual(
      expect.arrayContaining([
        'C:\\project\\.example\\skills',
        'C:\\home\\.example\\skills',
        'D:\\custom\\extensions\\skills',
        'C:\\project\\.agents\\skills',
        'C:\\home\\.agents\\skills',
      ]),
    );
  });
});
