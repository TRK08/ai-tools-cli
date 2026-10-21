import { describe, expect, it, vi } from 'vitest';
import { createRemoveUi } from '../../src/cli/ui/remove-ui.ts';
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
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('restores raw=%s and flowing=%s after confirmation', async (raw, flowing) => {
    const t = terminal(),
      ui = createRemoveUi(t, 'project', []);
    t.input.isRaw = raw;
    if (flowing) t.input.resume();
    else t.input.pause();
    try {
      ui.preview([record('demo')]);
      const pending = ui.review([record('demo')]);
      await vi.waitFor(() => expect(t.rendered()).toContain('Нет, оставить'));
      t.input.write('\r');
      expect(await pending).toBe(false);
      expect([t.input.isRaw, t.input.readableFlowing]).toEqual([raw, flowing]);
    } finally {
      t.close();
    }
  });

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

  it('restores the incoming raw and flowing state after selecting skills', async () => {
    const t = terminal(),
      ui = createRemoveUi(t, 'project', []);
    t.input.isRaw = true;
    t.input.resume();
    try {
      const pending = ui.select([record('demo')]);
      t.input.write(' \r');
      expect(await pending).toEqual([record('demo')]);
      expect([t.input.isRaw, t.input.readableFlowing]).toEqual([true, true]);
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
      ui.preview([record('demo')]);
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
      ui.preview([record('demo'), record('other')]);
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
