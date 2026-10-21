import { describe, expect, it, vi } from 'vitest';
import { createUpdatesUi } from '../../src/cli/updates-ui.ts';
import type { UpdatePreview } from '../../src/installer/types.ts';
import { terminal } from '../helpers/terminal.ts';

const preview: UpdatePreview = {
  name: 'demo',
  currentVersion: '1.0.0',
  latestVersion: '2.0.0',
  sourceKind: 'registry',
  scope: 'project',
  agents: ['codex', 'pi'],
  status: 'available',
  reason: 'version',
};

describe('update preview and result UI', () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('restores raw=%s and flowing=%s after confirmation', async (raw, flowing) => {
    const t = terminal(),
      ui = createUpdatesUi(t);
    t.input.isRaw = raw;
    if (flowing) t.input.resume();
    else t.input.pause();
    try {
      const pending = ui.review(preview);
      await vi.waitFor(() => expect(t.rendered()).toContain('Нет, пропустить'));
      t.input.write('\r');
      expect(await pending).toBe('decline');
      expect([t.input.isRaw, t.input.readableFlowing]).toEqual([raw, flowing]);
    } finally {
      ui.finish({ status: 'success', results: [] });
      t.close();
    }
  });

  it.each([
    ['copy', 'Заменить установленное содержимое'],
    ['connections', 'Восстановить подключения'],
    ['artifact', 'Архив изменился'],
    ['source', 'В источнике доступно обновлённое содержимое'],
  ] as const)('describes %s changes and still asks for confirmation', async (reason, text) => {
    const t = terminal(),
      ui = createUpdatesUi(t);
    try {
      const pending = ui.review({
        ...preview,
        sourceKind: reason === 'source' ? 'directory' : 'registry',
        reason,
      });
      await vi.waitFor(() => expect(t.rendered()).toContain(text));
      t.input.write('\r');
      expect(await pending).toBe('decline');
    } finally {
      ui.finish({ status: 'success', results: [] });
      t.close();
    }
  });

  it.each([
    ['\r', 'decline'],
    ['\u001b[C\r', 'approve'],
    ['\u0003', 'cancel'],
  ] as const)('returns the decision for %j with default No', async (key, decision) => {
    const t = terminal(),
      ui = createUpdatesUi(t);
    try {
      const pending = ui.review(preview);
      await vi.waitFor(() => expect(t.rendered()).toContain('Нет, пропустить'));
      expect(t.rendered()).toMatch(/1\.0\.0.*2\.0\.0/);
      expect(t.rendered()).toContain('codex, pi');
      t.input.write(key);
      expect(await pending).toBe(decision);
    } finally {
      ui.finish({ status: 'success', results: [] });
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
      await expect(createUpdatesUi(t).review(preview)).rejects.toThrow('используйте --yes');
      const ui = createUpdatesUi(t, true);
      expect(await ui.review(preview)).toBe('approve');
      ui.finish({ status: 'success', results: [] });
      expect(t.input.setRawMode).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });
  it.each(['unchanged', 'pinned'] as const)(
    'renders %s without asking or inventing latest',
    async (status) => {
      const t = terminal(false, false),
        ui = createUpdatesUi(t);
      try {
        expect(
          await ui.review({
            ...preview,
            status,
            reason: status === 'pinned' ? 'pinned' : null,
            latestVersion: status === 'pinned' ? null : '1.0.0',
          }),
        ).toBe('approve');
        ui.finish({
          status: 'success',
          results: [
            status === 'pinned'
              ? { name: 'demo', status, version: '1.0.0' }
              : { name: 'demo', status },
          ],
        });
        expect(t.rendered()).toContain(status === 'pinned' ? 'не проверялась' : 'Обновлений нет.');
        expect(t.input.setRawMode).not.toHaveBeenCalled();
      } finally {
        t.close();
      }
    },
  );
  it.each(['directory', 'archive'] as const)(
    'labels %s updates without a fictitious version',
    async (sourceKind) => {
      const t = terminal(false, false),
        ui = createUpdatesUi(t, true);
      try {
        await ui.review({
          ...preview,
          currentVersion: null,
          latestVersion: null,
          sourceKind,
          reason: 'source',
        });
        ui.finish({ status: 'success', results: [{ name: 'demo', status: 'success' }] });
        expect(t.rendered()).toContain('локальная');
        expect(t.rendered()).not.toContain('2.0.0');
      } finally {
        t.close();
      }
    },
  );
  it('renders batch failures, declined and cancelled results', async () => {
    const t = terminal(false, false),
      ui = createUpdatesUi(t, true, 'global');
    try {
      for (const name of ['demo', 'declined', 'failed', 'cancelled'])
        await ui.review({ ...preview, name });
      ui.finish({
        status: 'failed',
        results: [
          { name: 'demo', status: 'success' },
          { name: 'declined', status: 'skipped', reason: 'declined' },
          { name: 'failed', status: 'partial', errors: ['connection failure'] },
          { name: 'cancelled', status: 'skipped', reason: 'cancelled' },
        ],
      });
      expect(t.rendered()).toContain('глобальная');
      expect(t.rendered()).toContain('Обновлён');
      expect(t.rendered()).toContain('connection failure');
      expect(t.rendered()).toContain('обновление отклонено');
      expect(t.rendered()).toContain('Отменено перед обновлением cancelled');
    } finally {
      t.close();
    }
  });
});
