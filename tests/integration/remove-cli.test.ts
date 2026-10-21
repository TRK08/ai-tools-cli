import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/program.ts';
import { Installer } from '../../src/installer/installer.ts';
import type { AgentId, InstallationScope } from '../../src/installer/types.ts';

import { getStatePaths } from '../../src/state/paths.ts';
import { runCli } from '../helpers/cli.ts';
import { withTestEnvironment, type TestEnvironment } from '../helpers/test-environment.ts';

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

const approve = '\u001b[C\r';
const waitFor = (t: ReturnType<typeof terminal>, text: string) =>
  vi.waitFor(() => expect(t.rendered()).toContain(text), { interval: 10 });
const run = (f: TestEnvironment, t: ReturnType<typeof terminal>, args: string[] = []) =>
  createProgram({
    version: '0.1.0',
    runtime: f,
    stdin: t.input,
    stdout: t.output,
    stderr: t.output,
  }).parseAsync(['node', 'skills-installer', 'remove', ...args]);

async function install(
  f: TestEnvironment,
  names: string[] = ['demo'],
  scope: InstallationScope = 'project',
  agents: AgentId[] = ['codex', 'pi'],
) {
  const installer = new Installer(f, { scope });
  for (const name of names) {
    const source = join(f.roots.cwd, `source-${name}`);
    await mkdir(source);
    await writeFile(join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: Test\n---\n`);
    expect((await installer.add(source, false, agents)).status).toBe('success');
  }
  return installer;
}

describe('interactive removal with real Clack prompts', () => {
  it('preserves an agent added while the removal preview is open', async () => {
    await withTestEnvironment(async (f) => {
      const installer = await install(f, ['demo'], 'project', ['codex']);
      const t = terminal();
      try {
        const pending = run(f, t, ['demo']);
        await waitFor(t, 'Нет, оставить');
        expect(t.rendered()).toMatch(/│ demo\s+│ локальная\s+│ codex\s+│/);
        await installer.add(join(f.roots.cwd, 'source-demo'), false, ['pi']);
        t.input.write(approve);
        await pending;
        expect((await installer.list())[0]).toMatchObject({ name: 'demo', agents: ['pi'] });
      } finally {
        t.close();
      }
    });
  });
});

describe('remove in CLI processes without TTY', () => {
  it('continues after a partial removal, preserving the foreign object and returning code 1', async () => {
    await withTestEnvironment(async (f) => {
      const installer = await install(f, ['alpha', 'demo'], 'project', ['codex', 'claude-code']);
      const foreign = join(f.roots.cwd, '.claude', 'skills', 'alpha');
      await rm(foreign, { recursive: true });
      await writeFile(foreign, 'foreign');
      const result = await runCli(f, ['remove', 'alpha', 'demo', '--yes']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Путь агента занят чужим объектом');
      expect(result.stdout).toMatch(/│ alpha\s+│ локальная\s+│ Частично\s+│/);
      expect(result.stdout).toMatch(/│ demo\s+│ локальная\s+│ Удалён\s+│/);
      expect(result.stdout).toContain('Удалено: 1 · Нет совпадений: 0 · Ошибок: 1');
      expect(await readFile(foreign, 'utf8')).toBe('foreign');
      expect(await installer.list()).toMatchObject([{ name: 'alpha', agents: ['claude-code'] }]);
    });
  });

  it('continues after a thrown failure on the first shared copy', async () => {
    await withTestEnvironment(async (f) => {
      const installer = await install(f, ['alpha', 'demo'], 'project', ['codex']);
      const copy = join(getStatePaths(f.roots, 'project').skillsDirectory, 'alpha');
      await rm(copy, { recursive: true });
      await writeFile(copy, 'foreign file');
      const result = await runCli(f, ['remove', 'alpha', 'demo', '--yes']);
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/│ alpha\s+│ локальная\s+│ Ошибка\s+│/);
      expect(result.stdout).toMatch(/│ demo\s+│ локальная\s+│ Удалён\s+│/);
      expect(await readFile(copy, 'utf8')).toBe('foreign file');
      expect((await installer.list()).map((record) => record.name)).toEqual(['alpha']);
    });
  });
});
