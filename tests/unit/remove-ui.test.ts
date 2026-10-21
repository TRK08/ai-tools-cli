import { describe, expect, it, vi } from 'vitest';
import { createRemoveUi } from '../../src/cli/remove-ui.ts';
import type { InstallationRecord } from '../../src/state/types.ts';
import { terminal } from '../helpers/terminal.ts';

const record = (name: string): InstallationRecord => ({
  name,
  source: { kind: 'directory', path: '/source' },
  policy: 'local',
  version: null,
  contentHash: 'a'.repeat(64),
  agents: ['codex', 'pi'],
  connections: [],
});

describe('remove UI without filesystem operations', () => {
  it('cancels selection with Escape', async () => {
    const t = terminal(),
      ui = createRemoveUi(t, 'project', []);
    try {
      const pending = ui.select([record('demo')]);
      t.input.write('\u001b');
      expect(await pending).toBeNull();
    } finally {
      t.close();
    }
  });

  it('requires a mark and scrolls beyond eight choices', async () => {
    const records = Array.from({ length: 10 }, (_, i) => record(`demo-${i}`));
    const t = terminal(),
      ui = createRemoveUi(t, 'project', []);
    try {
      const pending = ui.select(records);
      t.input.write('\r');
      await new Promise<void>((done) => setImmediate(done));
      for (let i = 0; i < 9; i++) t.input.write('\u001b[B');
      t.input.write(' \r');
      expect(await pending).toEqual([records[9]]);
    } finally {
      t.close();
    }
  });
  it.each(['\r', '\u0003'] as const)('declines or cancels confirmation with %j', async (key) => {
    const t = terminal(),
      ui = createRemoveUi(t, 'project', []);
    try {
      const pending = ui.review([record('demo')]);
      await vi.waitFor(() => expect(t.rendered()).toContain('Нет, оставить'));
      t.input.write(key);
      expect(await pending).toBe(false);
    } finally {
      t.close();
    }
  });
  it('previews filtered agents once and accepts approval', async () => {
    const t = terminal(),
      ui = createRemoveUi(t, 'global', ['codex']);
    try {
      const pending = ui.review([record('demo'), record('other')]);
      await vi.waitFor(() => expect(t.rendered()).toContain('Нет, оставить'));
      expect(t.rendered()).not.toContain('codex, pi');
      t.input.write('\u001b[C\r');
      expect(await pending).toBe(true);
      expect(t.rendered()).toContain('глобальная');
    } finally {
      t.close();
    }
  });
  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])('requires --yes with TTY=%s/%s', async (input, output) => {
    const t = terminal(input, output);
    try {
      await expect(createRemoveUi(t, 'project', []).review([record('demo')])).rejects.toThrow(
        'используйте remove',
      );
      expect(await createRemoveUi(t, 'project', [], true).review([record('demo')])).toBe(true);
      expect(t.input.setRawMode).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });
  it('renders result versions, partial/failed diagnostics and empty/missing messages', () => {
    const t = terminal(false, false),
      ui = createRemoveUi(t, 'project', []);
    try {
      ui.missing('unknown');
      ui.empty();
      ui.finish(
        [{ ...record('demo'), version: '1.2.3' }, record('other')],
        [
          { name: 'demo', status: 'partial', errors: ['foreign object'] },
          { name: 'other', status: 'failed', errors: ['commit failure'] },
        ],
      );
      for (const text of [
        'unknown',
        'Нет подходящих',
        '1.2.3',
        'Частично',
        'foreign object',
        'commit failure',
      ])
        expect(t.rendered()).toContain(text);
    } finally {
      t.close();
    }
  });
});
