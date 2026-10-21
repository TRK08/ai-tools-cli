import { expect, it } from 'vitest';
import { addCardView } from '../../src/cli/commands/add-card.ts';
import type { AddPreview } from '../../src/installer/types.ts';
import { skillDetail } from '../helpers/discovery.ts';

const preview: AddPreview = {
  name: 'demo',
  version: null,
  description: 'Local description',
  source: { kind: 'directory', path: '/source' },
  scope: 'project',
  policy: 'local',
  sharedDirectory: '/fixture/.agents/skills/demo',
  destinations: [
    { agent: 'codex', path: '/fixture/.agents/skills/demo' },
    { agent: 'pi', path: '/fixture/.agents/skills/demo' },
    { agent: 'claude-code', path: '/fixture/.claude/skills/demo' },
  ],
};

it('groups destination labels and prepares local card data', () => {
  expect(addCardView(preview)).toEqual({
    name: 'demo',
    installationName: 'demo',
    version: null,
    source: '/source',
    scope: 'локальная — текущий проект',
    description: 'Local description',
    tags: [],
    sharedDirectory: '/fixture/.agents/skills/demo',
    destinations: [
      { path: '/fixture/.agents/skills/demo', agents: ['Codex', 'Pi'] },
      { path: '/fixture/.claude/skills/demo', agents: ['Claude Code'] },
    ],
  });
});

it('keeps selected registry version and installation name with display metadata', () => {
  const card = addCardView(
    {
      ...preview,
      scope: 'global',
      version: '1.0.0',
      policy: 'latest',
      source: { kind: 'registry', slug: 'demo', registryUrl: 'https://registry.test' },
    },
    skillDetail({ version: '1.0.0' }),
  );
  expect(card).toMatchObject({
    name: 'API Contract Checker',
    installationName: 'demo',
    slug: 'demo',
    version: '1.0.0',
    source: 'https://registry.test',
    scope: 'глобальная — для пользователя',
    description: 'Checks HTTP contracts',
    tags: ['Go', 'backend'],
    installCount: 2,
  });
});
