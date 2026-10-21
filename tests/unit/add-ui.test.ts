import { describe, expect, it, vi } from 'vitest';
import { createAddUi, selectScope } from '../../src/cli/add-ui.ts';
import type { AddPreview } from '../../src/installer/types.ts';
import type { RuntimeContext } from '../../src/runtime.ts';
import { skillDetail } from '../helpers/discovery.ts';
import { terminal } from '../helpers/terminal.ts';

const context: RuntimeContext = {
  roots: { cwd: '/fixture', home: '/fixture-home' },
  env: {},
  http: async () => {
    throw new Error('Unexpected HTTP');
  },
};
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

describe('add UI without installation', () => {
  it('shows local metadata and groups agents with the same path', async () => {
    const t = terminal(false, false),
      ui = createAddUi(context, t, true);
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
  it('requests only the selected registry card and shows short description', async () => {
    const http = vi.fn<typeof fetch>(async () => Response.json(skillDetail({ version: '1.0.0' })));
    const t = terminal(false, false),
      ui = createAddUi({ ...context, http }, t, true);
    try {
      expect(
        await ui.run(() =>
          ui.review({
            ...preview,
            version: '1.0.0',
            policy: 'latest',
            source: { kind: 'registry', registryUrl: 'https://registry.test', slug: 'demo' },
          }),
        ),
      ).toBe('approve');
      expect(String(http.mock.calls[0]![0])).toBe(
        'https://registry.test/api/v1/skills/demo?version=1.0.0',
      );
      expect(http).toHaveBeenCalledTimes(1);
      expect(t.rendered()).toContain('Checks HTTP contracts');
      expect(t.rendered()).not.toContain('Detailed contract validation');
      expect(t.rendered()).toContain('1.0.0');
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
      ui = createAddUi(context, t);
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
