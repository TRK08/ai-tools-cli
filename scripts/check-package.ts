import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { list as listTar } from 'tar';
import manifest from '../package.json' with { type: 'json' };
import { withIsolatedRuntime } from './isolated-runtime.ts';

const [input, ...extra] = process.argv.slice(2);
assert.ok(input && extra.length === 0, 'Используйте npm run package:smoke -- <archive.tgz>');
const archive = resolve(input);
const npmExecPath = process.env.npm_execpath;
assert.ok(npmExecPath, 'Запустите smoke через npm run package:smoke.');
const binPath = manifest.bin['skills-installer'].replace(/^\.\//, '');
const required = ['package.json', binPath, 'README.md', 'LICENSE', 'ThirdPartyNoticeText.txt'];

/** Проверяет готовый npm-архив без перепаковки; bytes и mode читаются из самого tar. */
async function checkArchive(): Promise<void> {
  const files = new Set<string>();
  const contents = new Map<string, Buffer>();
  await listTar({
    file: archive,
    strict: true,
    onReadEntry(entry) {
      assert.equal(entry.type, 'File', `Ожидался обычный файл: ${entry.path}`);
      assert.ok(entry.path.startsWith('package/'), `Неверный путь: ${entry.path}`);
      const path = entry.path.slice('package/'.length);
      assert.ok(!path.split('/').includes('..') && !path.includes('\\'));
      assert.ok(required.includes(path) || path.startsWith('dist/'), `Лишний файл: ${path}`);
      assert.ok(!files.has(path), `Повтор файла: ${path}`);
      files.add(path);
      if (path === binPath) assert.ok(entry.mode! & 0o111, 'CLI must be executable');
      if (path === 'package.json' || path === binPath) {
        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer) => chunks.push(chunk));
        entry.on('end', () => contents.set(path, Buffer.concat(chunks)));
      }
    },
  });
  for (const path of required) assert.ok(files.has(path), `Отсутствует файл: ${path}`);
  const packed = JSON.parse(contents.get('package.json')!.toString('utf8')) as typeof manifest;
  assert.equal(packed.name, manifest.name);
  assert.equal(packed.version, manifest.version);
  assert.deepEqual(packed.bin, manifest.bin);
  assert.ok(contents.get(binPath)!.toString('utf8').startsWith('#!/usr/bin/env node\n'));
}

await checkArchive();
await withIsolatedRuntime(async ({ temporaryRoot, roots, env }) => {
  const localInstall = join(temporaryRoot, 'Локальная npm установка');
  const prefix = env.npm_config_prefix!;
  await mkdir(localInstall);
  await writeFile(join(localInstall, 'package.json'), '{"private":true,"type":"module"}\n');
  const options = {
    cwd: roots.cwd,
    env,
    encoding: 'utf8' as const,
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
  };

  /** Запускает настоящий bin с одним фиксированным флагом; Windows использует npm .cmd. */
  function runBin(bin: string, flag: '--help' | '--version'): string {
    if (process.platform !== 'win32') return execFileSync(bin, [flag], options);
    // Fixture не поддерживает метасимволы в пути самого npm shim (npm/cmd-shim#45).
    assert.ok(!/[%!^&()"|\r\n]/.test(bin), `Неподдерживаемый путь npm shim: ${bin}`);
    const result = spawnSync(
      env.ComSpec ?? join(env.SystemRoot!, 'System32', 'cmd.exe'),
      ['/d', '/s', '/v:off', '/c', `""${bin}" ${flag}"`],
      {
        ...options,
        env: { ...env, PATH: dirname(process.execPath) + ';' + (env.PATH ?? '') },
        windowsVerbatimArguments: true,
      },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  }

  for (const global of [false, true]) {
    execFileSync(
      process.execPath,
      [
        npmExecPath,
        'install',
        ...(global ? ['--global', '--prefix', prefix] : []),
        archive,
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
      ],
      { ...options, cwd: localInstall },
    );
    const modules = global
      ? join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules')
      : join(localInstall, 'node_modules');
    const bin = global
      ? join(prefix, process.platform === 'win32' ? 'skills-installer.cmd' : 'bin/skills-installer')
      : join(modules, '.bin/skills-installer' + (process.platform === 'win32' ? '.cmd' : ''));
    assert.equal(runBin(bin, '--version').trim(), manifest.version);
    assert.match(runBin(bin, '--help'), /add/);
    for (const name of Object.keys(manifest.devDependencies)) {
      for (const directory of [modules, join(modules, manifest.name, 'node_modules')])
        assert.ok(!existsSync(join(directory, name)), `Установлена devDependency: ${name}`);
    }
  }
  console.log(`Package smoke passed: ${manifest.name}@${manifest.version}`);
  console.log(`Verified archive: ${archive}`);
});
