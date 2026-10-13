import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/cli/program.ts';
import { LocalInstaller } from '../src/installer/local.ts';
import type { AgentId, InstallationScope } from '../src/installer/types.ts';
import { hashDirectory } from '../src/state/hash.ts';
import { getStatePaths } from '../src/state/paths.ts';
import { runCli } from './helpers/cli.ts';
import { withTestEnvironment, type TestEnvironment } from './helpers/test-environment.ts';
import { versionRegistry } from './helpers/versions.ts';

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

const down = '\u001b[B';
const enter = '\r';
const approve = '\u001b[C\r';
const waitFor = (t: ReturnType<typeof terminal>, text: string) =>
  vi.waitFor(() => expect(t.rendered()).toContain(text), { interval: 10 });
const run = (f: TestEnvironment, t: ReturnType<typeof terminal>, args: string[] = []) =>
  createProgram('0.1.0', f, { write: (message) => t.output.write(`${message}\n`) }, t).parseAsync([
    'node',
    'skills-installer',
    'remove',
    ...args,
  ]);

async function install(
  f: TestEnvironment,
  names: string[] = ['demo'],
  scope: InstallationScope = 'project',
  agents: AgentId[] = ['codex', 'pi'],
) {
  const installer = new LocalInstaller(f, { scope });
  for (const name of names) {
    const source = join(f.roots.cwd, `source-${name}`);
    await mkdir(source);
    await writeFile(join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: Test\n---\n`);
    expect((await installer.add(source, false, agents)).status).toBe('success');
  }
  return installer;
}

describe('interactive removal with real Clack prompts', () => {
  it.each(['project', 'global'] as const)(
    'requires a selection, previews two skills and removes them only after confirmation in %s',
    async (scope) => {
      await withTestEnvironment(async (f) => {
        const installer = await install(f, ['alpha', 'demo', 'zeta'], scope);
        const http = vi.fn(f.http);
        const before = await hashDirectory(f.temporaryRoot);
        const t = terminal();
        try {
          const pending = run({ ...f, http }, t, scope === 'global' ? ['-g'] : []);
          await waitFor(t, 'Выберите скиллы для удаления');
          expect(t.rendered()).toContain(
            `Удаление скиллов · ${scope === 'project' ? 'текущий проект' : 'глобальная область'}`,
          );
          expect(t.rendered()).toContain('локальная · codex, pi');
          t.input.write(enter);
          await waitFor(t, 'Выберите хотя бы один пункт');
          expect(await hashDirectory(f.temporaryRoot)).toBe(before);
          t.input.write(` ${down} ${enter}`);
          await waitFor(t, 'Нет, оставить');
          expect(t.rendered()).toContain('Удалить 2 скилла у перечисленных агентов?');
          expect(t.rendered()).toMatch(/│ alpha\s+│ локальная\s+│ codex, pi\s+│/);
          expect(t.rendered()).toMatch(/│ demo\s+│ локальная\s+│ codex, pi\s+│/);
          expect(await hashDirectory(f.temporaryRoot)).toBe(before);
          t.input.write(approve);
          await pending;
          expect((await installer.list()).map((record) => record.name)).toEqual(['zeta']);
          expect(t.rendered()).toContain('Удалено: 2');
          expect(http).not.toHaveBeenCalled();
          for (const name of ['alpha', 'demo']) {
            expect(
              await readFile(join(f.roots.cwd, `source-${name}`, 'SKILL.md'), 'utf8'),
            ).toContain(name);
            await expect(
              lstat(join(getStatePaths(f.roots, scope).skillsDirectory, name)),
            ).rejects.toMatchObject({ code: 'ENOENT' });
          }
        } finally {
          t.close();
        }
      });
    },
  );

  it.each([
    { stage: 'selection', key: '\u001b' },
    { stage: 'selection', key: '\u0003' },
    { stage: 'confirmation', key: '\u001b' },
    { stage: 'confirmation', key: '\u0003' },
    { stage: 'confirmation', key: enter },
  ])('keeps every file on $stage cancellation with $key', async ({ stage, key }) => {
    await withTestEnvironment(async (f) => {
      await install(f);
      const before = await hashDirectory(f.temporaryRoot);
      const http = vi.fn(f.http);
      const t = terminal();
      try {
        const pending = run({ ...f, http }, t);
        await waitFor(t, 'Выберите скиллы для удаления');
        if (stage === 'confirmation') {
          t.input.write(` ${enter}`);
          await waitFor(t, 'Нет, оставить');
        }
        t.input.write(key);
        await pending;
        expect(t.rendered()).toMatch(/Удаление (отменено|отклонено)/);
        expect(await hashDirectory(f.temporaryRoot)).toBe(before);
        expect(http).not.toHaveBeenCalled();
      } finally {
        t.close();
      }
    });
  });

  it('skips selection for names, merges duplicates and confirms only matching skills once', async () => {
    await withTestEnvironment(async (f) => {
      const installer = await install(f, ['alpha', 'demo']);
      const t = terminal();
      try {
        const pending = run(f, t, ['demo', 'missing', 'alpha', 'demo']);
        await waitFor(t, 'Нет, оставить');
        expect(t.rendered()).not.toContain('Выберите скиллы для удаления');
        expect(t.rendered()).toContain('missing не имеет подходящей установки.');
        expect(t.rendered()).toContain('Удалить 2 скилла');
        t.input.write(approve);
        await pending;
        expect(await installer.list()).toEqual([]);
        expect(t.rendered()).toContain('Удалено: 2');
      } finally {
        t.close();
      }
    });
  });

  it('keeps the selection menu with --yes and scrolls past the eighth item', async () => {
    await withTestEnvironment(async (f) => {
      const names = Array.from(
        { length: 11 },
        (_, index) => `skill-${String(index).padStart(2, '0')}`,
      );
      const installer = await install(f, names, 'project', ['codex']);
      const t = terminal();
      try {
        const pending = run(f, t, ['--yes']);
        await waitFor(t, 'Выберите скиллы для удаления');
        expect(t.rendered()).not.toContain('skill-08');
        for (let index = 0; index < 10; index++) {
          t.input.write(down);
          await new Promise<void>((done) => setImmediate(done));
        }
        expect(t.rendered()).toContain('skill-10');
        t.input.write(` ${enter}`);
        await pending;
        expect(t.rendered()).not.toContain('Нет, оставить');
        expect((await installer.list()).map((record) => record.name)).toEqual(names.slice(0, 10));
      } finally {
        t.close();
      }
    });
  });

  it('filters choices and preview agents, preserving other connections and skills', async () => {
    await withTestEnvironment(async (f) => {
      const installer = await install(f, ['alpha']);
      await install(f, ['other'], 'project', ['claude-code']);
      const t = terminal();
      try {
        const pending = run(f, t, ['-a', 'pi', '-a', 'pi']);
        await waitFor(t, 'Выберите скиллы для удаления');
        expect(t.rendered()).toContain('локальная · pi');
        expect(t.rendered()).not.toContain('other');
        expect(t.rendered()).not.toContain('codex');
        t.input.write(` ${enter}`);
        await waitFor(t, 'Нет, оставить');
        expect(t.rendered()).toMatch(/│ alpha\s+│ локальная\s+│ pi\s+│/);
        t.input.write(approve);
        await pending;
        expect((await installer.list())[0]).toMatchObject({ name: 'alpha', agents: ['codex'] });
        expect((await installer.list())[1]).toMatchObject({
          name: 'other',
          agents: ['claude-code'],
        });
        expect(
          (
            await lstat(join(getStatePaths(f.roots, 'project').skillsDirectory, 'alpha'))
          ).isDirectory(),
        ).toBe(true);
      } finally {
        t.close();
      }
    });
  });

  it('does not prompt for an empty lock or a filter without matching installations', async () => {
    await withTestEnvironment(async (f) => {
      for (const args of [[], ['unknown']]) {
        const t = terminal();
        const before = await hashDirectory(f.temporaryRoot);
        try {
          await run(f, t, args);
          expect(t.rendered()).toContain('Нечего удалять.');
          expect(t.rendered()).not.toContain('Выберите скиллы для удаления');
          expect(await hashDirectory(f.temporaryRoot)).toBe(before);
        } finally {
          t.close();
        }
      }
      await install(f);
      const t = terminal();
      try {
        await run(f, t, ['demo', '-a', 'cursor']);
        expect(t.rendered()).toContain('demo не имеет подходящей установки.');
        expect(t.rendered()).not.toContain('Нет, оставить');
      } finally {
        t.close();
      }
    });
  });

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

  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])(
    'requires --yes for named changes when TTY is unavailable (%j, %j)',
    async (inputTTY, outputTTY) => {
      await withTestEnvironment(async (f) => {
        await install(f);
        const before = await hashDirectory(f.temporaryRoot);
        const t = terminal(inputTTY, outputTTY);
        try {
          await expect(run(f, t, ['demo'])).rejects.toThrow(/TTY.*--yes/);
          expect(await hashDirectory(f.temporaryRoot)).toBe(before);
          await expect(run(f, t, ['--yes'])).rejects.toThrow(/TTY.*remove demo --yes/);
          expect(await hashDirectory(f.temporaryRoot)).toBe(before);
          await run(f, t, ['demo', '--yes']);
          expect(t.rendered()).toContain('Удалено: 1');
        } finally {
          t.close();
        }
      });
    },
  );

  it('shows the installed registry version and removes without network, events or source access', async () => {
    const backend = versionRegistry();
    await withTestEnvironment(
      async (f) => {
        const installer = new LocalInstaller(f, { registry: backend.url });
        await installer.add('demo@1.0.0', false, ['codex']);
        backend.http.mockClear();
        const http = vi.fn(f.http);
        const t = terminal();
        try {
          const pending = run({ ...f, http }, t, ['demo']);
          await waitFor(t, 'Нет, оставить');
          expect(t.rendered()).toMatch(/│ demo\s+│ 1\.0\.0\s+│ codex\s+│/);
          t.input.write(approve);
          await pending;
          expect(await installer.list()).toEqual([]);
          expect(http).not.toHaveBeenCalled();
        } finally {
          t.close();
        }
      },
      { http: backend.http },
    );
  });
});

describe('remove in CLI processes without TTY', () => {
  it('reports a corrupt lock without treating it as an empty installation', async () => {
    await withTestEnvironment(async (f) => {
      await install(f);
      await writeFile(getStatePaths(f.roots, 'project').lockPath, '{invalid json');
      const before = await hashDirectory(f.temporaryRoot);
      const result = await runCli(f, ['remove', 'demo', '--yes']);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/JSON/);
      expect(result.stdout).not.toContain('Нечего удалять.');
      expect(await hashDirectory(f.temporaryRoot)).toBe(before);
    });
  });
  it.each(['project', 'global'] as const)(
    'removes modified and missing copies with --yes in %s only',
    async (scope) => {
      await withTestEnvironment(async (f) => {
        const installer = await install(f, ['alpha', 'demo'], scope);
        const otherScope = scope === 'project' ? 'global' : 'project';
        const other = new LocalInstaller(f, { scope: otherScope });
        await other.add(join(f.roots.cwd, 'source-demo'), false, ['codex']);
        const paths = getStatePaths(f.roots, scope);
        await writeFile(join(paths.skillsDirectory, 'alpha', 'SKILL.md'), 'manual edits');
        await rm(join(paths.skillsDirectory, 'demo'), { recursive: true });
        for (const name of ['alpha', 'demo'])
          await rm(join(f.roots.cwd, `source-${name}`), { recursive: true });
        const result = await runCli(f, [
          'remove',
          'alpha',
          'demo',
          '-y',
          ...(scope === 'global' ? ['-g'] : []),
        ]);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Удалено: 2');
        expect(result.stderr).toBe('');
        expect(await installer.list()).toEqual([]);
        expect((await other.list())[0]).toMatchObject({ name: 'demo', agents: ['codex'] });
      });
    },
  );

  it.each([
    { args: ['demo', '../escape', '--yes'], message: /Небезопасное имя скилла/ },
    { args: ['demo', '-a', 'unknown', '--yes'], message: /Неизвестный агент/ },
    { args: ['--all'], message: /неизвестный параметр/ },
    { args: ['demo'], message: /TTY.*--yes/ },
    { args: [], message: /TTY.*remove demo --yes/ },
    { args: ['--yes'], message: /TTY.*remove demo --yes/ },
  ])('rejects $args without deleting any files', async ({ args, message }) => {
    await withTestEnvironment(async (f) => {
      await install(f);
      const before = await hashDirectory(f.temporaryRoot);
      const result = await runCli(f, ['remove', ...args]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(message);
      expect(await hashDirectory(f.temporaryRoot)).toBe(before);
    });
  });

  it('does not expand a wildcard into installed names', async () => {
    await withTestEnvironment(async (f) => {
      await install(f);
      const before = await hashDirectory(f.temporaryRoot);
      const result = await runCli(f, ['remove', '*', '--yes']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('* не имеет подходящей установки.');
      expect(await hashDirectory(f.temporaryRoot)).toBe(before);
    });
  });

  it('continues after a partial removal, preserving the foreign object and returning code 1', async () => {
    await withTestEnvironment(async (f) => {
      const installer = await install(f, ['alpha', 'demo'], 'project', ['codex', 'claude-code']);
      const foreign = join(f.roots.cwd, '.claude', 'skills', 'alpha');
      await rm(foreign);
      await mkdir(foreign);
      await writeFile(join(foreign, 'keep'), 'foreign');
      const result = await runCli(f, ['remove', 'alpha', 'demo', '--yes']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Путь агента занят чужим объектом');
      expect(result.stdout).toMatch(/│ alpha\s+│ локальная\s+│ Частично\s+│/);
      expect(result.stdout).toMatch(/│ demo\s+│ локальная\s+│ Удалён\s+│/);
      expect(result.stdout).toContain('Удалено: 1 · Нет совпадений: 0 · Ошибок: 1');
      expect(await readFile(join(foreign, 'keep'), 'utf8')).toBe('foreign');
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

  it('leaves foreign skills and the Vercel lock untouched while skipping unknown names', async () => {
    await withTestEnvironment(async (f) => {
      await install(f);
      const foreign = join(getStatePaths(f.roots, 'project').skillsDirectory, 'unmanaged');
      await mkdir(foreign);
      await writeFile(join(foreign, 'SKILL.md'), 'unmanaged');
      const vercel = join(f.roots.cwd, 'skills-lock.json');
      await writeFile(vercel, 'vercel lock bytes');
      const result = await runCli(f, ['remove', 'demo', 'unmanaged', 'unknown', 'demo', '--yes']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Удалено: 1');
      expect(result.stdout).toContain('unmanaged не имеет подходящей установки.');
      expect(result.stdout).toContain('unknown не имеет подходящей установки.');
      expect(await readFile(join(foreign, 'SKILL.md'), 'utf8')).toBe('unmanaged');
      expect(await readFile(vercel, 'utf8')).toBe('vercel lock bytes');
      const again = await runCli(f, ['remove', 'demo']);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('Нечего удалять.');
    });
  });
});
