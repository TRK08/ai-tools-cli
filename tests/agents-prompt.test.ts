import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'fast-string-width';
import { describe, expect, it, vi } from 'vitest';
import { selectAgents } from '../src/cli/agents-prompt.ts';
import { searchMultiselect } from '../src/cli/search-multiselect.ts';
import { createProgram } from '../src/cli/program.ts';
import { Installer } from '../src/installer/installer.ts';
import { hashDirectory } from '../src/state/hash.ts';
import { withTestEnvironment } from './helpers/test-environment.js';

function terminal(inputTTY = true, outputTTY = true) {
  let rendered = '';
  const input = Object.assign(new PassThrough(), {
    isTTY: inputTTY,
    isRaw: false,
    setRawMode: vi.fn((raw: boolean) => {
      input.isRaw = raw;
    }),
  });
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        rendered += String(chunk);
        callback();
      },
    }),
    { isTTY: outputTTY, columns: 200, rows: 40 },
  );
  return {
    input,
    output,
    rendered: () => rendered,
    current: () => stripVTControlCharacters(rendered.slice(rendered.lastIndexOf('\u001b[J') + 3)),
    close() {
      input.destroy();
      output.destroy();
    },
  };
}
const tick = () => new Promise<void>((done) => setImmediate(done));
async function keys(t: ReturnType<typeof terminal>, sequence: string[]) {
  await tick();
  for (const key of sequence) {
    t.input.write(key);
    await tick();
  }
}
const down = '\u001b[B';
const up = '\u001b[A';
const enter = '\r';

describe('real Clack selection with controlled TTY streams', () => {
  it('scrolls additional choices and preserves multiple marks hidden by a filter', async () => {
    const t = terminal();
    try {
      t.output.columns = 48;
      t.output.rows = 18;
      const selected = searchMultiselect({
        ...t,
        message: 'Выберите агентов',
        sharedDirectory: '/temporary/.agents/skills',
        locked: [{ value: 'locked', label: 'Закреплённый' }],
        options: Array.from({ length: 12 }, (_, i) => ({
          value: `agent-${i}`,
          label: `Агент ${i}`,
          hint: '界'.repeat(100),
        })),
      });
      await keys(t, [' ', ...Array(10).fill(down)]);
      expect(t.current()).toContain('Агент 10');
      expect(t.current().trimEnd().split('\n').length).toBeLessThan(18);
      expect(
        t
          .current()
          .split('\n')
          .every((line) => stringWidth(line) < 48),
      ).toBe(true);
      await keys(t, [' ', ...'AGENT-0', enter]);
      expect(await selected).toEqual(['locked', 'agent-0', 'agent-10']);
    } finally {
      t.close();
    }
  });

  it('restores the visible cursor even when clearing the final frame throws', async () => {
    await withTestEnvironment(async (context) => {
      const t = terminal();
      try {
        const selected = selectAgents([], context, 'project', t);
        const rejection = expect(selected).rejects.toThrow('clear failure');
        vi.spyOn(t.output, 'write').mockImplementationOnce(() => {
          throw new Error('clear failure');
        });
        await keys(t, [enter]);
        await rejection;
        expect(t.input.isRaw).toBe(false);
        expect(t.input.listenerCount('keypress')).toBe(0);
        expect(t.output.listenerCount('resize')).toBe(0);
        expect(t.rendered()).toContain('\u001b[?25h');
      } finally {
        t.close();
      }
    });
  });

  it.each(['project', 'global'] as const)(
    'returns four locked agents in %s without selecting Claude',
    async (scope) => {
      await withTestEnvironment(async (context) => {
        const t = terminal();
        try {
          const selected = selectAgents([], context, scope, t);
          expect(t.rendered()).toContain('Всегда включены');
          for (const label of ['Claude Code', 'Codex', 'OpenCode', 'Cursor', 'Pi'])
            expect(t.rendered()).toContain(label);
          await keys(t, [up, down, enter]);
          expect(await selected).toEqual(['opencode', 'codex', 'cursor', 'pi']);
        } finally {
          t.close();
        }
      });
    },
  );

  it('searches names and IDs without losing selection, and permits empty search results', async () => {
    await withTestEnvironment(async (context) => {
      const t = terminal();
      try {
        const selected = selectAgents([], context, 'project', t);
        await keys(t, [...'CLAUDE-CODE', ' ', ...'zzz', enter]);
        expect(t.rendered()).toContain('Совпадений нет');
        expect(await selected).toEqual(['claude-code', 'opencode', 'codex', 'cursor', 'pi']);
      } finally {
        t.close();
      }
    });
  });

  it('clears the query with Backspace and toggles Claude off without affecting the locked group', async () => {
    await withTestEnvironment(async (context) => {
      const t = terminal();
      try {
        const selected = selectAgents([], context, 'project', t);
        await keys(t, [...'Code', ' ', ...'xyz']);
        expect(t.current()).toContain('Совпадений нет');
        await keys(t, Array(7).fill('\u007f'));
        expect(t.current()).not.toContain('Совпадений нет');
        await keys(t, [' ', enter]);
        expect(await selected).toEqual(['opencode', 'codex', 'cursor', 'pi']);
      } finally {
        t.close();
      }
    });
  });

  it('preserves selection through resize, blocks Enter in a tiny window, and bounds every frame', async () => {
    await withTestEnvironment(async (context) => {
      const t = terminal();
      try {
        t.output.columns = 48;
        t.output.rows = 18;
        let completed = false;
        const selected = selectAgents([], context, 'global', t).then((value) => {
          completed = true;
          return value;
        });
        await keys(t, [' ', ...'x'.repeat(100)]);
        const lines = t.current().trimEnd().split('\n');
        expect(lines.length).toBeLessThan(t.output.rows);
        expect(lines.every((line) => stringWidth(line) < t.output.columns)).toBe(true);
        t.output.columns = 18;
        t.output.rows = 4;
        t.output.emit('resize');
        await keys(t, [enter]);
        expect(completed).toBe(false);
        expect(t.current().trimEnd().split('\n').length).toBeLessThan(4);
        t.output.columns = 80;
        t.output.rows = 24;
        t.output.emit('resize');
        await keys(t, [enter]);
        expect(await selected).toEqual(['claude-code', 'opencode', 'codex', 'cursor', 'pi']);
      } finally {
        t.close();
      }
    });
  });

  it.each(['submit', 'escape', 'ctrl-c', 'end', 'close', 'error'] as const)(
    'restores raw mode and releases listeners on %s',
    async (way) => {
      await withTestEnvironment(async (context) => {
        const t = terminal();
        t.input.isRaw = true;
        t.input.pause();
        const counts = ['keypress', 'end', 'close', 'error'].map((event) =>
          t.input.listenerCount(event),
        );
        try {
          const selected = selectAgents([], context, 'project', t);
          const assertion =
            way === 'error' ? expect(selected).rejects.toThrow('input failure') : undefined;
          if (way === 'end') t.input.end();
          else if (way === 'close') t.input.destroy();
          else if (way === 'error') t.input.emit('error', new Error('input failure'));
          else await keys(t, [way === 'submit' ? enter : way === 'escape' ? '\u001b' : '\u0003']);
          if (assertion) await assertion;
          else
            expect(await selected).toEqual(
              way === 'submit' ? ['opencode', 'codex', 'cursor', 'pi'] : null,
            );
          expect(t.input.isRaw).toBe(true);
          expect(t.input.isPaused()).toBe(true);
          expect(
            ['keypress', 'end', 'close', 'error'].map((event) => t.input.listenerCount(event)),
          ).toEqual(counts);
          expect(t.output.listenerCount('resize')).toBe(0);
          expect(t.output.listenerCount('error')).toBe(0);
          expect(t.rendered()).toContain('\u001b[?25h');
        } finally {
          t.close();
        }
      });
    },
  );

  it('cancels an already ended input without enabling raw mode', async () => {
    await withTestEnvironment(async (context) => {
      const t = terminal();
      t.input.destroy();
      try {
        expect(await selectAgents([], context, 'project', t)).toBeNull();
        expect(t.input.setRawMode).not.toHaveBeenCalled();
      } finally {
        t.close();
      }
    });
  });

  it.each(['\u001b', '\u0003'])(
    'cancels with %j without reading source, HTTP or changing any files',
    async (key) => {
      await withTestEnvironment(async (context) => {
        const t = terminal();
        const http = vi.fn(context.http);
        const before = await hashDirectory(context.temporaryRoot);
        const output = { write: vi.fn() };
        try {
          const run = createProgram('0.1.0', { ...context, http }, output, t).parseAsync([
            'node',
            'skills-installer',
            'add',
            './missing',
            '--force',
            '-g',
          ]);
          await keys(t, [key]);
          await run;
          expect(output.write).toHaveBeenCalledWith('Отменено.');
          expect(http).not.toHaveBeenCalled();
          expect(await hashDirectory(context.temporaryRoot)).toBe(before);
        } finally {
          t.close();
        }
      });
    },
  );

  it('installs four defaults and keeps Claude after it is deselected in a later menu', async () => {
    await withTestEnvironment(async (context) => {
      const source = join(context.roots.cwd, 'demo');
      await mkdir(source);
      await writeFile(join(source, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n');
      for (const sequence of [[enter], [' ', enter], [enter]]) {
        const t = terminal();
        try {
          const run = createProgram('0.1.0', context, { write: vi.fn() }, t).parseAsync([
            'node',
            'skills-installer',
            'add',
            './demo',
            '--yes',
          ]);
          await keys(t, [enter, ...sequence]);
          await run;
        } finally {
          t.close();
        }
      }
      const records = await new Installer(context).list();
      expect(records[0]!.agents).toEqual(['claude-code', 'codex', 'cursor', 'opencode', 'pi']);
      expect(records[0]!.connections).toHaveLength(5);
      expect(
        await readFile(join(context.roots.cwd, '.claude/skills/demo/SKILL.md'), 'utf8'),
      ).toContain('name: demo');
      expect((await lstat(join(context.roots.cwd, '.agents/skills/demo'))).isDirectory()).toBe(
        true,
      );
      expect((await readdir(context.roots.cwd)).sort()).toEqual([
        '.agents',
        '.claude',
        'demo',
        'skills-installer-lock.json',
      ]);
    });
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])('requires TTY for both streams (%j, %j)', async (inputTTY, outputTTY) => {
    await withTestEnvironment(async (context) => {
      const t = terminal(inputTTY, outputTTY);
      try {
        const before = await hashDirectory(context.temporaryRoot);
        await expect(
          createProgram('0.1.0', context, { write: vi.fn() }, t).parseAsync([
            'node',
            'skills-installer',
            'add',
            './missing',
          ]),
        ).rejects.toThrow(/TTY.*укажите -a/);
        expect(t.rendered()).toBe('');
        expect(await hashDirectory(context.temporaryRoot)).toBe(before);
      } finally {
        t.close();
      }
    });
  });

  it('explicit repeated agents bypass the menu even with TTY, and unknown values fail before output', async () => {
    await withTestEnvironment(async (context) => {
      const t = terminal();
      try {
        expect(await selectAgents(['pi', 'pi', 'codex'], context, 'project', t)).toEqual([
          'codex',
          'pi',
        ]);
        await expect(selectAgents(['pi', 'unknown'], context, 'project', t)).rejects.toThrow(
          'Неизвестный агент',
        );
        expect(t.rendered()).toBe('');
      } finally {
        t.close();
      }
    });
  });
});
