import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
const artifactDirectory = join(repositoryRoot, 'artifacts/npm');
const temporaryRoot = mkdtempSync(join(realpathSync(tmpdir()), 'skills-installer-package-'));
const temporaryHome = join(temporaryRoot, 'home');
mkdirSync(temporaryHome);
const userConfig = join(temporaryRoot, 'user.npmrc');
const globalConfig = join(temporaryRoot, 'global.npmrc');
writeFileSync(userConfig, '');
writeFileSync(globalConfig, '');
const isolatedEnvironment = {
  PATH: process.env.PATH,
  TMPDIR: tmpdir(),
  HOME: temporaryHome,
  XDG_CONFIG_HOME: join(temporaryHome, '.config'),
  CLAUDE_CONFIG_DIR: join(temporaryHome, '.claude'),
  npm_config_userconfig: userConfig,
  npm_config_globalconfig: globalConfig,
  npm_config_cache: join(temporaryRoot, 'npm-cache'),
  DO_NOT_TRACK: '1',
  DISABLE_TELEMETRY: '1',
};

/** Запускает команду без shell, с временным home и npm-конфигурацией; ненулевой код прерывает проверку. */
function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    env: isolatedEnvironment,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Проверяет список файлов npm-архива: runtime, shebang, executable и отсутствие локальных данных. */
function checkContents(pack) {
  assert.equal(pack.name, manifest.name);
  assert.equal(pack.version, manifest.version);
  const paths = pack.files.map((file) => file.path);
  for (const required of [
    'package.json',
    'dist/cli.mjs',
    'README.md',
    'LICENSE',
    'ThirdPartyNoticeText.txt',
  ]) {
    assert.ok(paths.includes(required), `Missing package file: ${required}`);
  }
  for (const path of paths) {
    assert.ok(
      path.startsWith('dist/') ||
        ['package.json', 'README.md', 'LICENSE', 'ThirdPartyNoticeText.txt'].includes(path),
      `Unexpected package file: ${path}`,
    );
  }
  assert.ok(
    readFileSync(join(repositoryRoot, 'dist/cli.mjs'), 'utf8').startsWith('#!/usr/bin/env node\n'),
  );
  assert.ok(
    pack.files.find((file) => file.path === 'dist/cli.mjs').mode & 0o111,
    'CLI must be executable',
  );
}

/** Проверяет установленный bin и локальный/глобальный жизненный цикл; все установки ограничены временными корнями. */
function checkInstalledCli(bin, cwd, source, global) {
  const scope = global ? ['--global'] : [];
  const installedRoot = global ? temporaryHome : cwd;
  const skillPath = join(installedRoot, '.agents/skills/package-smoke');
  const connectionPath = join(installedRoot, '.claude/skills/package-smoke');
  assert.equal(run(bin, ['--version'], cwd).trim(), manifest.version);
  assert.match(run(bin, ['--help'], cwd), /add/);
  run(bin, ['list', ...scope], cwd);
  run(
    bin,
    ['add', source, ...scope, '-a', 'codex', '-a', 'claude-code', '--yes', '--without-stat'],
    cwd,
  );
  assert.equal(
    readFileSync(join(skillPath, 'SKILL.md'), 'utf8'),
    readFileSync(join(source, 'SKILL.md'), 'utf8'),
  );
  assert.equal(lstatSync(connectionPath).isSymbolicLink(), global);
  assert.equal(lstatSync(connectionPath).isDirectory(), !global);
  if (global) assert.equal(realpathSync(connectionPath), realpathSync(skillPath));
  else assert.notEqual(realpathSync(connectionPath), realpathSync(skillPath));
  assert.equal(
    readFileSync(join(connectionPath, 'SKILL.md'), 'utf8'),
    readFileSync(join(skillPath, 'SKILL.md'), 'utf8'),
  );
  assert.match(run(bin, ['list', ...scope], cwd), /package-smoke/);
  run(bin, ['update', 'package-smoke', ...scope, '--yes', '--without-stat'], cwd);
  run(bin, ['remove', 'package-smoke', ...scope, '--yes'], cwd);
  assert.ok(!existsSync(skillPath));
  assert.ok(!existsSync(connectionPath));
  assert.doesNotMatch(run(bin, ['list', ...scope], cwd), /package-smoke/);
}

try {
  mkdirSync(artifactDirectory, { recursive: true });
  const [preview] = JSON.parse(
    run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], repositoryRoot),
  );
  checkContents(preview);
  const [pack] = JSON.parse(
    run(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', artifactDirectory],
      repositoryRoot,
    ),
  );
  checkContents(pack);
  const archive = join(artifactDirectory, pack.filename);
  const project = join(temporaryRoot, 'project');
  const prefix = join(temporaryRoot, 'prefix');
  const source = join(temporaryRoot, 'source');
  mkdirSync(project);
  mkdirSync(source);
  writeFileSync(join(project, 'package.json'), '{"private":true,"type":"module"}\n');
  writeFileSync(
    join(source, 'SKILL.md'),
    '---\nname: package-smoke\ndescription: Проверка npm-архива\n---\n\n# Smoke\n',
  );
  run(
    'npm',
    ['install', archive, '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'],
    project,
  );
  run('npm', ['ls', '--omit=dev'], project);
  checkInstalledCli(join(project, 'node_modules/.bin/skills-installer'), project, source, false);
  run(
    'npm',
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      archive,
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
    ],
    project,
  );
  checkInstalledCli(join(prefix, 'bin/skills-installer'), project, source, true);
  assert.ok(
    !existsSync(join(project, 'node_modules/vitest')),
    'Dev dependencies must not be installed',
  );
  console.log(`Package smoke passed: ${manifest.name}@${manifest.version}`);
  console.log(`Verified archive: ${archive}`);
} finally {
  // Временными home, проектом и npm-prefix владеет эта проверка; архив сохраняется для CI/публикации.
  rmSync(temporaryRoot, { recursive: true, force: true });
}
