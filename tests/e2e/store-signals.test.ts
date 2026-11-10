import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import { getStatePaths } from '@/state';
import { requireBuiltCli, runBuiltCli } from '../helpers/built-cli.ts';
import { withE2eRegistry } from '../helpers/e2e-registry.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

beforeAll(requireBuiltCli);

it('serializes the same store key across CLI processes and downloads only once', async () => {
  await withE2eRegistry(async (registry) => {
    registry.release('docs', '1.0.0', ['check']);
    const http = registry.http;
    registry.http = async (url, init) => {
      if (String(url).includes('/download/'))
        await new Promise((resolve) => setTimeout(resolve, 150));
      return http(url, init);
    };
    await withTestEnvironment(async (f) => {
      const cwd = join(f.temporaryRoot, 'second');
      await mkdir(cwd);
      const context = {
        ...f,
        env: { ...f.env, SKILLS_API_URL: registry.url, DISABLE_TELEMETRY: '', DO_NOT_TRACK: '' },
      };
      const args = ['add', 'docs', '-p', '-a', 'codex', '-y'];
      const outcomes = await Promise.all([
        runBuiltCli(context, args),
        runBuiltCli({ ...context, roots: { ...f.roots, cwd } }, args),
      ]);
      for (const outcome of outcomes) expect(outcome.status, outcome.stderr).toBe(0);
      expect(registry.requests.filter((path) => path.startsWith('/download/'))).toHaveLength(1);
      expect(registry.events.map(({ body }) => body.event).sort()).toEqual([
        'download',
        'install',
        'install',
      ]);
      expect(
        (await readdir(join(f.roots.home, '.skills-installer/store'))).filter((name) =>
          /\.lock$|\.tmp-/.test(name),
        ),
      ).toEqual([]);
      const bytes = await readFile(join(cwd, '.agents/skills/docs-check/SKILL.md'), 'utf8');
      expect(bytes).toContain('1.0.0');
    });
  });
});

it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'] as const)(
  'cleans up a blocked download after repeated %s without immediate process exit',
  async (signal) => {
    await withE2eRegistry(async (registry) => {
      registry.release('docs', '1.0.0', ['check']);
      let started!: () => void, release!: () => void;
      const downloading = new Promise<void>((resolve) => {
        started = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const http = registry.http;
      registry.http = async (url, init) => {
        if (String(url).includes('/download/')) {
          started();
          await resume;
        }
        return http(url, init);
      };
      await withTestEnvironment(async (f) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url)),
            'add',
            'docs',
            '-p',
            '-a',
            'claude-code',
            '-y',
          ],
          {
            cwd: f.roots.cwd,
            env: { ...f.env, SKILLS_API_URL: registry.url },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        const closed = new Promise<{ code: number | null; signal: string | null }>(
          (resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
          },
        );
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          release();
        }, 8000);
        try {
          await Promise.race([
            downloading,
            closed.then(() => {
              throw new Error(stderr);
            }),
          ]);
          child.kill(signal);
          child.kill(signal);
          const outcome = await closed;
          expect(outcome, stderr).toEqual({ code: 0, signal: null });
          expect(stdout).toContain('Отменено.');
          const paths = getStatePaths(f.roots, 'project');
          for (const path of [
            paths.lockPath,
            paths.operationLockPath,
            join(paths.skillsDirectory, 'docs-check'),
          ])
            await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(
            (await readdir(paths.agentsDirectory)).filter((name) =>
              name.startsWith('.skills-installer-work-'),
            ),
          ).toEqual([]);
          expect(
            (await readdir(join(f.roots.home, '.skills-installer/store'))).filter((name) =>
              /\.lock$|\.tmp-/.test(name),
            ),
          ).toEqual([]);
        } finally {
          clearTimeout(timer);
          release();
          if (child.exitCode === null) child.kill('SIGKILL');
        }
      });
    });
  },
);

it('uses saved registry in a new process and shows one fixed popular page with total', async () => {
  await withE2eRegistry(async (registry) => {
    registry.release(
      'docs',
      '1.0.0',
      Array.from({ length: 30 }, (_, i) => `document-${String(i).padStart(2, '0')}`),
    );
    registry.releases.get('docs@1.0.0')![29]!.wire.installCount = 100;
    await withTestEnvironment(async (f) => {
      expect((await runBuiltCli(f, ['config', 'set', 'registry', registry.url])).status).toBe(0);
      const result = await runBuiltCli(f, ['find', 'document']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Найдено: 30. Показано: 10.');
      expect(result.stdout.match(/^document-\d{2}  docs  1\.0\.0$/gm)).toEqual(
        [29, 0, 1, 2, 3, 4, 5, 6, 7, 8].map(
          (i) => `document-${String(i).padStart(2, '0')}  docs  1.0.0`,
        ),
      );
      expect(registry.requests).toEqual([
        '/api/v1/components?kind=skill&q=document&sort=popular&limit=10',
      ]);
      const count = registry.requests.length;
      for (const args of [
        ['find', ' ab '],
        ['find', 'ab', '-y'],
        ['find', 'document', '--limit', '25'],
        ['find', 'document', '--limit=10'],
        ['find', 'document', '--sort', 'name'],
      ])
        expect((await runBuiltCli(f, args)).status).toBe(1);
      expect(registry.requests).toHaveLength(count);
    });
  });
});

it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'] as const)(
  'rolls back the built CLI when %s arrives during file application',
  async (signal) => {
    await withE2eRegistry(async (registry) => {
      registry.release('docs', '1.0.0', ['check']);
      await withTestEnvironment(async (f) => {
        const context = { ...f, env: { ...f.env, SKILLS_API_URL: registry.url } };
        const args = ['add', 'docs', '-p', '-a', 'claude-code', '-y'];
        expect((await runBuiltCli(context, args)).status).toBe(0);
        const paths = getStatePaths(f.roots, 'project');
        const original = await readFile(paths.lockPath);
        registry.release('docs', '2.0.0', ['check']);
        // Inject an OS signal immediately after rename, before the CLI's next cancellation checkpoint.
        const hook = `import fs from 'node:fs';
          import { syncBuiltinESMExports } from 'node:module';
          const rename = fs.promises.rename;
          fs.promises.rename = async (from, to) => {
            await rename(from, to);
            if (String(from).includes('staging-') && String(to).endsWith('docs-check')) {
              process.kill(process.pid, '${signal}');
              await new Promise(resolve => setTimeout(resolve, 20));
            }
          };
          syncBuiltinESMExports();`;
        const child = spawn(
          process.execPath,
          [
            '--import',
            'data:text/javascript,' + encodeURIComponent(hook),
            fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url)),
            'update',
            'docs',
            '-y',
          ],
          {
            cwd: f.roots.cwd,
            env: context.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 8000,
          },
        );
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk;
        });
        child.stderr.on('data', (chunk) => {
          output += chunk;
        });
        const outcome = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal }));
        });
        expect(outcome, output).toEqual({ code: 0, signal: null });
        expect(output).toContain('Отменено.');
        expect(await readFile(paths.lockPath)).toEqual(original);
        expect(
          await readFile(join(f.roots.cwd, '.claude/skills/docs-check/SKILL.md'), 'utf8'),
        ).toContain('1.0.0');
        await expect(access(paths.operationLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(
          (await readdir(paths.agentsDirectory)).filter((name) =>
            name.startsWith('.skills-installer-work-'),
          ),
        ).toEqual([]);
      });
    });
  },
);
