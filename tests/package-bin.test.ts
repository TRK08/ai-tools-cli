import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };
import { withIsolatedRuntime } from '../scripts/isolated-runtime.ts';
import { preparePackageArchive } from '../scripts/package-archive.ts';
import { preparePackageFixture } from '../scripts/package-fixture.ts';
import { packageRunner } from '../scripts/package-runner.ts';

it(
  'runs real local/global npm bins from a metacharacter cwd with literal arguments',
  { timeout: 60_000 },
  async () => {
    await withIsolatedRuntime(async (fixture) => {
      const { localInstall, prefix, project, source } = await preparePackageFixture(
        fixture.temporaryRoot,
      );
      const binPath = manifest.bin['skills-installer'];
      const bin = join(fixture.roots.cwd, binPath);
      await mkdir(dirname(bin), { recursive: true });
      await writeFile(
        bin,
        [
          '#!/usr/bin/env node',
          'import { readFileSync } from "node:fs";',
          'import { join } from "node:path";',
          'console.log(JSON.stringify({',
          '  args: process.argv.slice(2), cwd: process.cwd(),',
          '  bytes: [...readFileSync(join(process.argv[2], "ресурс.bin"))]',
          '}));',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(fixture.roots.cwd, 'package.json'),
        JSON.stringify({
          name: 'package-bin-regression',
          version: '1.0.0',
          type: 'module',
          bin: manifest.bin,
        }),
      );
      await writeFile(join(localInstall, 'package.json'), '{"private":true}\n');
      const bytes = [0, 255, 128, 13, 10];
      await writeFile(join(source, 'ресурс.bin'), Buffer.from(bytes));
      const runner = packageRunner(fixture.env, process.env.npm_execpath);
      const archive = await preparePackageArchive(
        runner,
        fixture.roots.cwd,
        fixture.env.TMPDIR!,
        binPath.replace(/^\.\//, ''),
      );
      const args = [
        source,
        '',
        'два слова',
        '%PATH%',
        '&',
        '(скобки)',
        '!',
        '^',
        'a"b',
        'конец \\',
      ];
      for (const global of [false, true]) {
        runner.npm(
          [
            'install',
            ...(global ? ['--global', '--prefix', prefix] : []),
            archive,
            '--offline',
            '--omit=dev',
            '--no-audit',
            '--no-fund',
            '--ignore-scripts',
          ],
          localInstall,
        );
        const installedBin = global
          ? join(
              prefix,
              process.platform === 'win32' ? 'skills-installer.cmd' : 'bin/skills-installer',
            )
          : join(
              localInstall,
              'node_modules/.bin/skills-installer' + (process.platform === 'win32' ? '.cmd' : ''),
            );
        expect(JSON.parse(runner.bin(installedBin, args, project))).toEqual({
          args,
          cwd: project,
          bytes,
        });
      }
    });
  },
);
