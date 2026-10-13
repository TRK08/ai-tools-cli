import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { selectAgents } from '../src/cli/agents-prompt.ts';
import { createProgram } from '../src/cli/program.ts';
import { LocalInstaller } from '../src/installer/local.ts';
import { hashDirectory } from '../src/state/hash.ts';
import { withTestEnvironment } from './helpers/test-environment.js';

function terminal(inputTTY = true, outputTTY = true) {
  let rendered = '';
  const input = Object.assign(new PassThrough(), { isTTY: inputTTY, setRawMode: vi.fn() });
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
  it('returns fixed defaults with all five choices and scoped destination hints', async () => {
    await withTestEnvironment(async (context) => {
      const t = terminal();
      try {
        const selected = selectAgents([], context, 'global', t);
        expect(t.rendered()).toContain('Claude Code');
        expect(t.rendered()).toContain('Cursor');
        expect(t.rendered()).toContain('Pi');
        expect(t.rendered()).toContain(join(context.roots.home, '.config/opencode/skills'));
        await keys(t, [down, down, down, down]);
        expect(t.rendered()).toContain(join(context.roots.home, '.pi/agent/skills'));
        await keys(t, [enter]);
        expect(await selected).toEqual(['claude-code', 'opencode', 'codex']);
      } finally {
        t.close();
      }
    });
  });

  it('toggles every default off, rejects empty submission, then returns Pi using arrows and space', async () => {
    await withTestEnvironment(async (context) => {
      const t = terminal();
      try {
        let completed = false;
        const selected = selectAgents([], context, 'project', t).then((value) => {
          completed = true;
          return value;
        });
        await keys(t, [' ', down, ' ', down, ' ', enter]);
        expect(completed).toBe(false);
        expect(t.rendered()).toContain('Выберите хотя бы один пункт');
        await keys(t, [down, down, ' ', up, down, enter]);
        expect(await selected).toEqual(['pi']);
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

  it('installs the returned defaults, then keeps earlier agents when the next menu selects only Pi', async () => {
    await withTestEnvironment(async (context) => {
      const source = join(context.roots.cwd, 'demo');
      await mkdir(source);
      await writeFile(join(source, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n');
      for (const sequence of [[enter], [' ', down, ' ', down, ' ', down, down, ' ', enter]]) {
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
      const records = await new LocalInstaller(context).list();
      expect(records[0]!.agents).toEqual(['claude-code', 'codex', 'opencode', 'pi']);
      expect(records[0]!.connections).toHaveLength(4);
      expect(await readFile(join(context.roots.cwd, '.pi/skills/demo/SKILL.md'), 'utf8')).toContain(
        'name: demo',
      );
      expect((await lstat(join(context.roots.cwd, '.agents/skills/demo'))).isDirectory()).toBe(
        true,
      );
      const t = terminal();
      try {
        const selected = selectAgents([], context, 'project', t);
        await keys(t, [enter]);
        expect(await selected).toEqual(['claude-code', 'opencode', 'codex']);
      } finally {
        t.close();
      }
      expect((await readdir(context.roots.cwd)).sort()).toEqual([
        '.agents',
        '.claude',
        '.pi',
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
          'pi',
          'codex',
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
