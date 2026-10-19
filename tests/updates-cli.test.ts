import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/cli/program.ts';
import { Installer } from '../src/installer/installer.ts';
import { hashDirectory } from '../src/state/hash.ts';
import { getStatePaths } from '../src/state/paths.ts';
import { withRegistryServer, json } from './helpers/registry.ts';
import { withTestEnvironment, type TestEnvironment } from './helpers/test-environment.ts';
import { versionArtifact, versionBytes, versionRegistry } from './helpers/versions.ts';
import { skillDetail } from './helpers/discovery.ts';

import { runCli } from './helpers/cli.ts';

/** Использует общий runner; прежние сценарии add явно подтверждают установку. */
function cli(f: TestEnvironment, args: string[]) {
  return runCli(f, args[0] === 'add' ? [...args, '--yes'] : args);
}

describe('update CLI', () => {
  it.each(['project', 'global'] as const)(
    'runs versions, no-op downloads and partial batches in %s scope',
    async (scope) => {
      let current = '1.0.0';
      let failDemo = false;
      await withRegistryServer(
        async ({ url, requests }) =>
          withTestEnvironment(
            async (f) => {
              const flags = scope === 'global' ? ['-g'] : [];
              const add = (source: string) =>
                cli(f, [
                  'add',
                  source,
                  '--registry',
                  `${url}/origin`,
                  '-a',
                  'codex',
                  '-a',
                  'pi',
                  ...flags,
                ]);
              expect((await add('demo')).status).toBe(0);
              const paths = getStatePaths(f.roots, scope);
              const saved = await readFile(paths.lockPath);
              const inode = (await lstat(join(paths.skillsDirectory, 'demo'))).ino;
              requests.length = 0;
              expect(await cli(f, ['update', ...flags])).toMatchObject({
                status: 0,
                stdout: expect.stringContaining('Обновлений нет.'),
                stderr: '',
              });
              expect(requests).toEqual(['/origin/api/v1/skills/demo/artifact']);
              expect(await readFile(paths.lockPath)).toEqual(saved);
              current = '2.0.0';
              requests.length = 0;
              const update = await cli(f, [
                'update',
                'demo',
                '-a',
                'codex',
                '-a',
                'codex',
                ...flags,
                '--yes',
              ]);
              expect(update.status).toBe(0);
              expect(update.stdout).toContain('затрагиваемые агенты: codex, pi');
              expect(update.stdout).toMatch(/│ demo\s+│.*│ Обновлён\s+│/);
              expect(requests).toHaveLength(2);
              expect((await lstat(join(paths.skillsDirectory, 'demo'))).ino).not.toBe(inode);
              expect((await add('demo@1.0.0')).status).toBe(0);
              requests.length = 0;
              expect(await cli(f, ['update', 'demo', '--force', ...flags])).toMatchObject({
                status: 0,
                stdout: expect.stringContaining('Закреплён (exact)'),
                stderr: '',
              });
              expect(requests).toEqual([]);
              expect((await add('demo')).status).toBe(0);
              expect((await add('other')).status).toBe(0);
              failDemo = true;
              current = '3.0.0';
              const batch = await cli(f, ['update', '--yes', ...flags]);
              expect(batch.status).toBe(1);
              expect(batch.stdout).toContain('Ошибка demo');
              expect(batch.stdout).toMatch(/│ other\s+│.*│ Обновлён\s+│/);
              expect(batch.stderr).toContain('Не удалось');
              const listed = await cli(f, ['list', ...flags]);
              expect(listed.stdout).toContain('other');
              expect(listed.stdout).toMatch(/│ other\s+│ 3\.0\.0\s+│ codex, pi\s+│/);
            },
            { env: { SKILLS_API_URL: 'http://127.0.0.1:1' } },
          ),
        (req, res, url) => {
          const requested = new URL(req.url!, url);
          const detail = /^\/origin\/api\/v1\/skills\/(demo|other)$/.exec(requested.pathname);
          if (detail) {
            const version = requested.searchParams.get('version') ?? current;
            return json(
              res,
              skillDetail({
                slug: detail[1],
                currentVersion: current,
                version,
                versions: [...new Set([current, version])],
              }),
            );
          }
          const match = /^\/origin\/api\/v1\/skills\/(demo|other)\/artifact$/.exec(
            requested.pathname,
          );
          if (match) {
            const name = match[1]!;
            if (failDemo && name === 'demo') {
              json(res, {}, 503);
              return;
            }
            const version = requested.searchParams.get('version') ?? current;
            json(res, versionArtifact(`${url}/origin`, name, version));
            return;
          }
          const download = /^\/origin\/download\/(demo|other)\/([^/]+)$/.exec(requested.pathname);
          if (download) res.end(versionBytes(download[1]!, download[2]!));
          else json(res, {}, 404);
        },
      );
    },
  );

  it('uses saved agents without a selection menu with --yes even when TTY is available', async () => {
    const backend = versionRegistry();
    await withTestEnvironment(
      async (f) => {
        await new Installer(f, { registry: backend.url }).add('demo', false, ['pi']);
        backend.current.demo = '2.0.0';
        const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
        let rendered = '';
        const output = Object.assign(
          new Writable({
            write(chunk, _encoding, done) {
              rendered += String(chunk);
              done();
            },
          }),
          { isTTY: true, columns: 120 },
        );
        const write = vi.fn();
        try {
          await createProgram('0.1.0', f, { write }, { input, output }).parseAsync([
            'node',
            'skills-installer',
            'update',
            '--yes',
          ]);
          expect(input.setRawMode).not.toHaveBeenCalled();
          expect(rendered).toContain('Текущая');
          expect(rendered).toContain('Доступная');
          expect(rendered).toMatch(/│ demo\s+│ 1\.0\.0\s+│ 2\.0\.0\s+│ Обновлён\s+│/);
          expect((await new Installer(f).list())[0]!.agents).toEqual(['pi']);
        } finally {
          input.destroy();
          output.destroy();
        }
      },
      { http: backend.http },
    );
  });

  it('updates local sources, protects edits, and continues after a missing source in a child process', async () => {
    await withTestEnvironment(async (f) => {
      for (const name of ['demo', 'other']) {
        const source = join(f.roots.cwd, name);
        await mkdir(source);
        await writeFile(
          join(source, 'SKILL.md'),
          `---\nname: ${name}\ndescription: Test\n---\nOriginal\n`,
        );
        expect((await cli(f, ['add', `./${name}`, '-a', 'codex', '-a', 'pi'])).status).toBe(0);
      }
      await writeFile(
        join(f.roots.cwd, 'demo', 'SKILL.md'),
        '---\nname: demo\ndescription: Test\n---\nNext\n',
      );
      const copy = join(getStatePaths(f.roots, 'project').skillsDirectory, 'demo');
      await writeFile(join(copy, 'manual'), 'keep');
      const before = await hashDirectory(copy);
      expect((await cli(f, ['update', 'demo'])).status).toBe(1);
      expect(await hashDirectory(copy)).toBe(before);
      expect((await cli(f, ['update', 'demo', '--force', '--yes'])).status).toBe(0);
      await rm(join(f.roots.cwd, 'demo'), { recursive: true });
      await writeFile(join(f.roots.cwd, 'other', 'new'), 'updated');
      const result = await cli(f, ['update', '--yes']);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Ошибка demo');
      expect(result.stdout).toMatch(/│ other\s+│.*│ Обновлён\s+│/);
    });
  });

  it.each([
    { args: ['update'], status: 0, stdout: /Нет подходящих скиллов/, stderr: /^$/ },
    {
      args: ['update', '-a', 'codex', '-a', 'pi'],
      status: 0,
      stdout: /Нет подходящих скиллов/,
      stderr: /^$/,
    },
    { args: ['update', 'missing'], status: 1, stdout: /^$/, stderr: /не установлен/ },
    { args: ['update', '-a', 'unknown'], status: 1, stdout: /^$/, stderr: /Неизвестный агент/ },
    {
      args: ['update', 'demo', 'other'],
      status: 1,
      stdout: /^$/,
      stderr: /слишком много аргументов/,
    },
    {
      args: ['update', '--registry', 'https://example.test'],
      status: 1,
      stdout: /^$/,
      stderr: /неизвестный параметр/,
    },
  ])('handles $args with code $status without TTY', async ({ args, status, stdout, stderr }) => {
    await withTestEnvironment(async (f) => {
      const result = await cli(f, args);
      expect(result.status).toBe(status);
      expect(result.stdout).toMatch(stdout);
      expect(result.stderr).toMatch(stderr);
    });
  });
});
