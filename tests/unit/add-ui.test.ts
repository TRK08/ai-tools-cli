import { describe, expect, it, vi } from 'vitest';
import { createAddUi } from '../../src/cli/ui/add-ui.ts';
import { selectScope } from '../../src/cli/commands/selection.ts';
import type { AddCardView } from '../../src/cli/ui/types.ts';
import type { RuntimeContext } from '../../src/runtime.ts';
import { terminal } from '../helpers/terminal.ts';

const context: RuntimeContext = {
  roots: { cwd: '/fixture', home: '/fixture-home' },
  env: {},
  http: async () => {
    throw new Error('Unexpected HTTP');
  },
};
const preview: AddCardView = {
  name: 'demo',
  installationName: 'demo',
  tags: [],
  version: null,
  description: 'Local description',
  source: '/source',
  scope: 'локальная — текущий проект',
  sharedDirectory: '/fixture/.agents/skills/demo',
  destinations: [
    { agents: ['Codex', 'Pi'], path: '/fixture/.agents/skills/demo' },
    { agents: ['Claude Code'], path: '/fixture/.claude/skills/demo' },
  ],
};

describe('add UI without installation', () => {
  it('shows local metadata and groups agents with the same path', async () => {
    const t = terminal(false, false),
      ui = createAddUi(t, true);
    try {
      expect(await ui.run(() => ui.review(preview))).toBe('approve');
      expect(t.rendered()).toContain('Local description');
      expect(t.rendered()).toContain('локальный источник');
      expect(t.rendered()).toContain('Codex, Pi');
      expect(t.rendered()).toContain('Claude Code');
      expect(t.rendered()).not.toContain('Установить demo?');
    } finally {
      t.close();
    }
  });
  it('renders ready registry metadata without runtime or HTTP', async () => {
    const t = terminal(false, false),
      ui = createAddUi(t, true);
    try {
      expect(
        await ui.run(() =>
          ui.review({
            ...preview,
            name: 'Display name',
            slug: 'demo',
            version: '1.0.0',
            source: 'https://registry.test',
            description: 'Checks HTTP contracts',
            tags: ['tools'],
            installCount: 42,
          }),
        ),
      ).toBe('approve');
      expect(t.rendered()).toContain('Checks HTTP contracts');
      expect(t.rendered()).toContain('Slug: demo');
      expect(t.rendered()).toContain('Теги: tools');
      expect(t.rendered()).toContain('Установок: 42');
    } finally {
      t.close();
    }
  });
  it.each([
    ['\r', 'decline'],
    ['\u001b[C\r', 'approve'],
    ['\u0003', 'cancel'],
  ] as const)('returns %s decision %s', async (key, decision) => {
    const t = terminal(),
      ui = createAddUi(t);
    try {
      const pending = ui.run(() => ui.review(preview));
      await vi.waitFor(() => expect(t.rendered()).toContain('Установить demo?'));
      t.input.write(key);
      expect(await pending).toBe(decision);
      expect(t.input.isRaw).toBe(false);
    } finally {
      t.close();
    }
  });
  it.each([false, true])('bypasses scope selection without TTY: global=%s', async (global) => {
    const t = terminal(false, false);
    try {
      expect(await selectScope(global, context, t)).toBe(global ? 'global' : 'project');
      expect(t.rendered()).toBe('');
    } finally {
      t.close();
    }
  });
});
