import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { list as listTar } from 'tar';
import { withIsolatedRuntime } from './isolated-runtime.mjs';
import { packageRunner } from './package-runner.mjs';
import { preparePackageArchive } from './package-archive.mjs';
import { preparePackageFixture } from './package-fixture.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
const binPath = manifest.bin['skills-installer'].replace(/^\.\//, '');
const artifactDirectory = join(repositoryRoot, 'artifacts/npm');
await withIsolatedRuntime(async ({ temporaryRoot, roots, env }) => {
  const temporaryHome = roots.home;
  const runner = packageRunner(env, process.env.npm_execpath);
  const run = runner.bin;
  const npm = runner.npm;
  // Проверяется реальный homedir/tmpdir дочернего Node, а не только объект env.
  const detected = JSON.parse(
    execNode([
      '--input-type=module',
      '--eval',
      'import {homedir,tmpdir} from "node:os";console.log(JSON.stringify([homedir(),tmpdir()]))',
    ]),
  );
  assert.deepEqual(detected, [temporaryHome, env.TMPDIR]);
  /** Проверяет runtime дочернего Node без обращения к пользовательскому env. */
  function execNode(args) {
    return execFileSync(process.execPath, args, { cwd: roots.cwd, env, encoding: 'utf8' });
  }

  /** Проверяет allowlist, shebang и executable-mode объявленного npm bin в подготовленном архиве. */
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
      readFileSync(join(repositoryRoot, binPath), 'utf8').startsWith('#!/usr/bin/env node\n'),
    );
    assert.ok(
      pack.files.find((file) => file.path === binPath).mode & 0o111,
      'CLI must be executable',
    );
  }

  /** Сверяет bytes всех ресурсов через SHA-256, независимо от прав/времени файлов. */
  function treeHash(root) {
    const hash = createHash('sha256');
    function visit(path, name) {
      if (lstatSync(path).isDirectory()) {
        for (const entry of readdirSync(path).sort()) visit(join(path, entry), name + '/' + entry);
      } else {
        const bytes = readFileSync(path);
        hash.update(JSON.stringify([name, bytes.length]));
        hash.update(bytes);
      }
    }
    visit(realpathSync(root), '');
    return hash.digest('hex');
  }

  /** Проверяет установленный bin и локальный/глобальный жизненный цикл; все установки ограничены временными корнями. */
  function checkInstalledCli(bin, cwd, source, global) {
    writeFileSync(join(source, 'ресурс.bin'), Buffer.from([0, 255, 128]));
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
    assert.equal(treeHash(skillPath), treeHash(source));
    assert.equal(treeHash(connectionPath), treeHash(source));
    const lockPath = global
      ? join(temporaryHome, '.agents/skills-installer-lock.json')
      : join(cwd, 'skills-installer-lock.json');
    const record = JSON.parse(readFileSync(lockPath, 'utf8')).skills['package-smoke'];
    assert.match(record.contentHash, /^[a-f0-9]{64}$/);
    assert.match(run(bin, ['list', ...scope], cwd), /package-smoke/);
    writeFileSync(join(source, 'ресурс.bin'), Buffer.from([0, 255, 128, 1]));
    run(bin, ['update', 'package-smoke', ...scope, '--yes', '--without-stat'], cwd);
    assert.equal(treeHash(skillPath), treeHash(source));
    assert.equal(treeHash(connectionPath), treeHash(source));
    assert.notEqual(
      JSON.parse(readFileSync(lockPath, 'utf8')).skills['package-smoke'].contentHash,
      record.contentHash,
    );
    run(bin, ['remove', 'package-smoke', ...scope, '--yes'], cwd);
    assert.ok(!existsSync(skillPath));
    assert.ok(!existsSync(connectionPath));
    assert.doesNotMatch(run(bin, ['list', ...scope], cwd), /package-smoke/);
  }

  mkdirSync(artifactDirectory, { recursive: true });
  const prepared = await preparePackageArchive(runner, repositoryRoot, env.TMPDIR, binPath);
  const [preview] = JSON.parse(
    npm(['pack', prepared, '--dry-run', '--json', '--ignore-scripts'], repositoryRoot),
  );
  checkContents(preview);
  const [pack] = JSON.parse(
    npm(
      ['pack', prepared, '--json', '--ignore-scripts', '--pack-destination', artifactDirectory],
      repositoryRoot,
    ),
  );
  checkContents(pack);
  const archive = join(artifactDirectory, pack.filename);
  let archivedBin = false;
  await listTar({
    file: archive,
    onReadEntry(entry) {
      if (entry.path === `package/${binPath}`) {
        archivedBin = true;
        assert.ok(entry.mode & 0o111, 'Archive bin must retain executable mode on every OS');
      }
    },
  });
  assert.ok(archivedBin, 'Missing bin in actual tar headers');
  const { localInstall, prefix, project, source } = await preparePackageFixture(temporaryRoot);
  writeFileSync(join(localInstall, 'package.json'), '{"private":true,"type":"module"}\n');
  writeFileSync(
    join(source, 'SKILL.md'),
    '---\nname: package-smoke\ndescription: Проверка npm-архива\n---\n\n# Smoke\n',
  );
  npm(
    ['install', archive, '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'],
    localInstall,
  );
  npm(['ls', '--omit=dev'], localInstall);
  const localPackage = join(localInstall, 'node_modules', manifest.name);
  assert.ok(readFileSync(join(localPackage, binPath), 'utf8').startsWith('#!/usr/bin/env node\n'));
  checkInstalledCli(
    join(
      localInstall,
      'node_modules/.bin/skills-installer' + (process.platform === 'win32' ? '.cmd' : ''),
    ),
    project,
    source,
    false,
  );
  npm(
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
  checkInstalledCli(
    join(prefix, process.platform === 'win32' ? 'skills-installer.cmd' : 'bin/skills-installer'),
    project,
    source,
    true,
  );
  const globalModules = join(
    prefix,
    process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
  );
  const globalPackage = join(globalModules, manifest.name);
  assert.ok(readFileSync(join(globalPackage, binPath), 'utf8').startsWith('#!/usr/bin/env node\n'));
  for (const name of Object.keys(manifest.devDependencies)) {
    for (const directory of [
      join(localInstall, 'node_modules'),
      join(localPackage, 'node_modules'),
      globalModules,
      join(globalPackage, 'node_modules'),
    ])
      assert.ok(
        !existsSync(join(directory, name)),
        `Dev dependency must not be installed: ${name}`,
      );
  }
  console.log(`Package smoke passed: ${manifest.name}@${manifest.version}`);
  console.log(`Verified archive: ${archive}`);
});
