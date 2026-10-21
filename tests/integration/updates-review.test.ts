import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/program.ts';
import { Installer } from '../../src/installer/installer.ts';

import { getStatePaths, WORKSPACE_PREFIX } from '../../src/state/paths.ts';
import { archiveBytes, skillText } from '../helpers/archive.ts';
import { withTestEnvironment, type TestEnvironment } from '../helpers/test-environment.ts';
import { versionRegistry } from '../helpers/versions.ts';

function terminal(inputTTY = true, outputTTY = true) {
  let rendered = '';
  const input = Object.assign(new PassThrough(), { isTTY: inputTTY, setRawMode: vi.fn() });
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        rendered += String(chunk);
        done();
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

const run = (f: TestEnvironment, t: ReturnType<typeof terminal>, args: string[] = []) =>
  createProgram({
    version: '0.1.0',
    runtime: f,
    stdin: t.input,
    stdout: t.output,
    stderr: t.output,
  }).parseAsync(['node', 'skills-installer', 'update', ...args]);
const waitForPrompt = (t: ReturnType<typeof terminal>) =>
  vi.waitFor(() => expect(t.rendered()).toContain('Нет, пропустить'), { interval: 10 });
const approve = (t: ReturnType<typeof terminal>) => t.input.write('\u001b[C\r');

describe('update tables and confirmation', () => {
  it.each(['project'] as readonly ('project' | 'global')[])(
    'shows versions and all agents before download, then installs the approved version in %s',
    async (scope) => {
      const backend = versionRegistry();
      await withTestEnvironment(
        async (f) => {
          const installer = new Installer(f, { scope, registry: backend.url });
          await installer.add('demo', false, ['codex', 'pi']);
          backend.current.demo = '2.0.0';
          backend.requests.length = 0;
          const paths = getStatePaths(f.roots, scope);
          const before = await readFile(paths.lockPath);
          const t = terminal();
          try {
            const pending = run(f, t, [
              'demo',
              '-a',
              'codex',
              ...(scope === 'global' ? ['-g'] : []),
            ]);
            await waitForPrompt(t);
            expect(t.rendered()).toContain('Текущая');
            expect(t.rendered()).toContain('Доступная');
            expect(t.rendered()).toMatch(/│ demo\s+│ 1\.0\.0\s+│ 2\.0\.0\s+│.*│ codex, pi\s+│/);
            expect(t.rendered()).toContain('Обновить demo (1.0.0 → 2.0.0)?');
            expect(backend.requests).toEqual([`${backend.url}/api/v1/skills/demo/artifact`]);
            expect(await readFile(paths.lockPath)).toEqual(before);
            expect((await installer.list())[0]!.version).toBe('1.0.0');
            // A new current version during the prompt must not change the approved artifact.
            backend.current.demo = '3.0.0';
            approve(t);
            await pending;
            expect(backend.requests).toEqual([
              `${backend.url}/api/v1/skills/demo/artifact`,
              `${backend.url}/download/demo/2.0.0`,
            ]);
            expect((await installer.list())[0]).toMatchObject({
              version: '2.0.0',
              agents: ['codex', 'pi'],
            });
            expect(t.rendered()).toMatch(/│ demo\s+│.*│ Обновлён\s+│/);
          } finally {
            t.close();
          }
        },
        { http: backend.http },
      );
    },
  );

  it('asks for each package and continues to the next after a decline', async () => {
    const backend = versionRegistry();
    await withTestEnvironment(
      async (f) => {
        const installer = new Installer(f, { registry: backend.url });
        await installer.add('demo');
        await installer.add('other');
        backend.current.demo = backend.current.other = '2.0.0';
        const t = terminal();
        try {
          const pending = run(f, t);
          await waitForPrompt(t);
          t.input.write('\r');
          await vi.waitFor(
            () => expect(t.rendered()).toContain('Обновить other (1.0.0 → 2.0.0)?'),
            {
              interval: 10,
            },
          );
          approve(t);
          await pending;
          expect((await installer.list()).map((record) => record.version)).toEqual([
            '1.0.0',
            '2.0.0',
          ]);
        } finally {
          t.close();
        }
      },
      { http: backend.http },
    );
  });

  it.each(['directory', 'archive'])(
    'cleans prepared local %s when the user declines',
    async (kind) => {
      await withTestEnvironment(async (f) => {
        const source = join(f.roots.cwd, kind === 'directory' ? 'input' : 'input.tgz');
        const set = async (text: string) => {
          if (kind === 'directory') {
            await mkdir(source, { recursive: true });
            await writeFile(join(source, 'SKILL.md'), text);
          } else await writeFile(source, archiveBytes([{ path: 'SKILL.md', contents: text }]));
        };
        await set(skillText);
        const installer = new Installer(f);
        await installer.add(source);
        await set(`${skillText}Updated\n`);
        const paths = getStatePaths(f.roots, 'project');
        const before = await readFile(paths.lockPath);
        const t = terminal();
        try {
          const pending = run(f, t);
          await waitForPrompt(t);
          expect(t.rendered()).toMatch(/│ demo\s+│ локальная\s+│ локальная\s+│/);
          t.input.write('\r');
          await pending;
          expect(await readFile(paths.lockPath)).toEqual(before);
          expect(
            (await readdir(paths.agentsDirectory)).filter((n) => n.startsWith(WORKSPACE_PREFIX)),
          ).toEqual([]);
        } finally {
          t.close();
        }
      });
    },
  );

  it('keeps an earlier approved update when the next package is cancelled', async () => {
    const backend = versionRegistry();
    await withTestEnvironment(
      async (f) => {
        const installer = new Installer(f, { registry: backend.url });
        await installer.add('demo');
        await installer.add('other');
        backend.current.demo = backend.current.other = '2.0.0';
        const t = terminal();
        try {
          const pending = run(f, t);
          await waitForPrompt(t);
          approve(t);
          await vi.waitFor(
            () => expect(t.rendered()).toContain('Обновить other (1.0.0 → 2.0.0)?'),
            {
              interval: 10,
            },
          );
          t.input.write('\u0003');
          await pending;
          expect((await installer.list()).map((record) => record.version)).toEqual([
            '2.0.0',
            '1.0.0',
          ]);
          expect(t.rendered()).toMatch(/│ demo\s+│.*│ Обновлён\s+│/);
          expect(t.rendered()).toContain('Отменено перед обновлением other.');
        } finally {
          t.close();
        }
      },
      { http: backend.http },
    );
  });

  it('protects a manual edit made while the user considers the update', async () => {
    const backend = versionRegistry();
    await withTestEnvironment(
      async (f) => {
        const installer = new Installer(f, { registry: backend.url });
        await installer.add('demo');
        backend.current.demo = '2.0.0';
        const paths = getStatePaths(f.roots, 'project');
        const before = await readFile(paths.lockPath);
        const manual = join(paths.skillsDirectory, 'demo', 'manual');
        const t = terminal();
        try {
          const pending = run(f, t);
          // Handle the expected rejection immediately while the prompt is still pending.
          const rejected = expect(pending).rejects.toThrow(/Не удалось/);
          await waitForPrompt(t);
          await writeFile(manual, 'concurrent edit');
          approve(t);
          await rejected;
          expect(t.rendered()).toContain('изменён локально');
          expect(await readFile(manual, 'utf8')).toBe('concurrent edit');
          expect(await readFile(paths.lockPath)).toEqual(before);
        } finally {
          t.close();
        }
      },
      { http: backend.http },
    );
  });
});
