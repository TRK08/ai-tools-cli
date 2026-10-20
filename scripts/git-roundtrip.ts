import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashDirectory } from '../src/state/hash.ts';
import type { LockFile } from '../src/state/types.ts';
import { withIsolatedRuntime } from './isolated-runtime.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const skill = 'git-roundtrip';
const agents = ['codex', 'claude-code', 'opencode', 'cursor', 'pi'];
const copies = ['.agents/skills', '.claude/skills'];
const vercelBytes = Buffer.from('{"version":1,"skills":{"external":"untouched"}}');
const forms = ['NFC', 'NFD'] as const;
type Form = (typeof forms)[number];
type Git = (args: string[], cwd: string) => string;
type Fixture = Parameters<Parameters<typeof withIsolatedRuntime>[0]>[0];
interface Receipt {
  producer: string;
  form: Form;
  commit: string;
  contentHash: string;
}

/** Запускает процесс без shell в изолированном env; отказ сохраняет stdout/stderr. */
function command(
  program: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  status = 0,
) {
  const result = spawnSync(program, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    status,
    `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

/** Отключает пользовательский Git config/hooks/signing; все файлы и автор принадлежат fixture. */
async function gitRunner(fixture: Fixture): Promise<Git> {
  const config = join(fixture.temporaryRoot, 'gitconfig');
  const templates = join(fixture.temporaryRoot, 'git-templates');
  await writeFile(config, '', { flag: 'wx' });
  await mkdir(templates);
  const env = {
    ...fixture.env,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'CLI Git fixture',
    GIT_COMMITTER_NAME: 'CLI Git fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-10-19T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-10-19T00:00:00Z',
  };
  return (args, cwd) =>
    command(
      'git',
      [
        '-c',
        `core.hooksPath=${templates}`,
        '-c',
        `init.templateDir=${templates}`,
        '-c',
        'commit.gpgSign=false',
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.file.allow=always',
        ...args,
      ],
      cwd,
      env,
    );
}

/** Проверяет эффективные attributes каждого ресурса до git add; вложенные overrides не обходят проверку. */
export function assertGitResourceAttributes(git: Git, cwd: string, paths: string[]): void {
  const fields = git(
    ['check-attr', '-z', 'text', 'filter', 'ident', 'working-tree-encoding', '--', ...paths],
    cwd,
  )
    .split('\0')
    .slice(0, -1);
  assert.equal(fields.length, paths.length * 12);
  for (let i = 0; i < fields.length; i += 3) {
    const [path, attribute, value] = fields.slice(i, i + 3);
    assert.ok(
      attribute === 'text' ? value === 'unset' : value === 'unset' || value === 'unspecified',
      `Git изменит bytes: ${path}, ${attribute}=${value}`,
    );
  }
}

/** Создаёт независимый набор LF/CRLF/binary/hidden/deep ресурсов; варианты Unicode никогда не смешиваются. */
function resources(form: Form): Record<string, Buffer> {
  return {
    'SKILL.md': Buffer.from(
      `---\nname: ${skill}\ndescription: Git byte roundtrip\n---\n# Fixture\n`,
    ),
    'lf.txt': Buffer.from('LF\nnext\n'),
    'crlf.txt': Buffer.from('CRLF\r\nnext\r\n'),
    'mixed.txt': Buffer.from('LF\nCRLF\r\nCR\rlast'),
    'binary.bin': Buffer.from([0, 255, 128, 13, 10, 0]),
    'run.sh': Buffer.from('#!/bin/sh\nprintf fixture\n'),
    '.hidden': Buffer.from('hidden\r\n'),
    ['café.txt'.normalize(form)]: Buffer.from('Unicode bytes\n'),
    'nested/node_modules/resource/deep.tgz': Buffer.from('archive resource\r\n'),
    'nested/dist/.DS_Store': Buffer.from([0, 1, 255]),
    'nested/.agents/.skills-installer-work-resource/asset': Buffer.from('ordinary resource'),
    'nested/.skills-installer-operation.lock': Buffer.from('ordinary resource'),
    'nested/.skills-installer-lock-resource.tmp': Buffer.from('ordinary resource'),
  };
}

/** Снимает точные bytes обычных файлов, сравнивая переносимые имена в NFC; ссылки запрещены. */
async function treeFiles(root: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const relative = `${prefix}${name}`;
      const stats = await lstat(path);
      if (stats.isDirectory()) await visit(path, relative + '/');
      else {
        assert.ok(stats.isFile(), `Не обычный файл: ${path}`);
        const key = relative.normalize('NFC');
        assert.ok(!result.has(key), `Unicode-коллизия: ${relative}`);
        result.set(key, await readFile(path));
      }
    }
  }
  await visit(root, '');
  return new Map([...result].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Сверяет bytes всех ресурсов и contentHash обеих обычных проектных копий с lock. */
async function checkCopies(
  project: string,
  expected: Map<string, Buffer>,
  contentHash: string,
): Promise<void> {
  const lock = JSON.parse(
    await readFile(join(project, 'skills-installer-lock.json'), 'utf8'),
  ) as LockFile;
  const record = lock.skills[skill]!;
  assert.equal(record.contentHash, contentHash);
  assert.deepEqual(record.agents.toSorted(), agents.toSorted());
  const byAgent = (a: { agent: string }, b: { agent: string }) =>
    a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0;
  assert.deepEqual(
    record.connections.toSorted(byAgent),
    agents
      .map((agent) => ({
        agent,
        kind: agent === 'claude-code' ? 'copy' : 'direct',
        path: `${agent === 'claude-code' ? '.claude' : '.agents'}/skills/${skill}`,
      }))
      .sort(byAgent),
  );
  for (const base of copies) {
    const path = join(project, base, skill);
    assert.ok((await lstat(path)).isDirectory());
    assert.deepEqual(await treeFiles(path), expected);
    assert.equal(await hashDirectory(path), contentHash);
  }
  assert.deepEqual(await readFile(join(project, 'skills-lock.json')), vercelBytes);
}

/** Запускает собранный dist CLI; никакой исходный/модельный Installer не заменяет lifecycle. */
function cli(fixture: Fixture, cwd: string, args: string[], status = 0): string {
  return command(
    process.execPath,
    [join(repository, 'dist/cli.mjs'), ...args, '--without-stat'],
    cwd,
    fixture.env,
    status,
  );
}

/** Создаёт исходник и пустую папку; caller удаляет весь temporaryRoot. */
async function createSource(path: string, form: Form): Promise<void> {
  for (const [name, bytes] of Object.entries(resources(form))) {
    const file = join(path, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  await mkdir(join(path, 'empty', 'child'), { recursive: true });
  await chmod(join(path, 'run.sh'), 0o755);
}

/** Создаёт standalone bundles и receipts без абсолютных source-path; не меняет рабочий Git. */
export async function produceGitBundles(output: string): Promise<void> {
  await mkdir(output, { recursive: true });
  let portableHash: string | undefined;
  for (const form of forms) {
    await withIsolatedRuntime(async (fixture) => {
      const project = fixture.roots.cwd;
      const git = await gitRunner(fixture);
      git(['init', '--quiet', '-b', 'main'], project);
      git(['config', 'core.autocrlf', 'false'], project);
      await copyFile(join(repository, '.gitignore'), join(project, '.gitignore'));
      await writeFile(
        join(project, '.gitignore'),
        (await readFile(join(project, '.gitignore'))) + '\n!source/**\n',
      );
      await writeFile(
        join(project, '.gitattributes'),
        (await readFile(join(repository, '.gitattributes'))) +
          '\nsource/** -text -filter -ident -working-tree-encoding\n',
      );
      await writeFile(join(project, 'skills-lock.json'), vercelBytes);
      await createSource(join(project, 'source'), form);
      cli(fixture, project, [
        'add',
        './source',
        ...agents.flatMap((agent) => ['-a', agent]),
        '--yes',
      ]);
      // Внешний source не попадёт в bundle; consumers проверяют list/remove без него.
      const external = join(fixture.temporaryRoot, 'external');
      await mkdir(external);
      await writeFile(
        join(external, 'SKILL.md'),
        '---\nname: external-skill\ndescription: External\n---\nExternal\n',
      );
      cli(fixture, project, ['add', external, '-a', 'codex', '-a', 'claude-code', '--yes']);
      const lock = JSON.parse(
        await readFile(join(project, 'skills-installer-lock.json'), 'utf8'),
      ) as LockFile;
      const record = lock.skills[skill]!;
      portableHash ??= record.contentHash;
      assert.equal(record.contentHash, portableHash, 'NFC/NFD должны иметь один contentHash');
      assert.deepEqual(record.agents.toSorted(), agents.toSorted());
      for (const record of Object.values(lock.skills)) {
        assert.ok(
          record.source.kind === 'directory' &&
            !record.source.path.startsWith('/') &&
            !record.source.path.includes('\\') &&
            !record.source.path.includes(':'),
        );
        for (const connection of record.connections)
          assert.ok(
            !connection.path.includes('\\') &&
              !connection.path.startsWith('/') &&
              !connection.path.includes(':'),
          );
      }
      const expected = await treeFiles(join(project, 'source'));
      await checkCopies(project, expected, record.contentHash);
      const resourcePaths = ['source', ...copies.map((base) => `${base}/${skill}`)].flatMap(
        (base) => [...expected.keys()].map((name) => `${base}/${name}`),
      );
      // На macOS Git и файловая система могут представлять имена в разных Unicode-формах.
      assertGitResourceAttributes(git, project, resourcePaths);
      await mkdir(join(project, '.agents/.skills-installer-work-leftover'), { recursive: true });
      await writeFile(join(project, '.agents/.skills-installer-work-leftover/recovery'), 'ignored');
      await writeFile(join(project, '.skills-installer-operation.lock'), 'ignored');
      await writeFile(join(project, '.skills-installer-lock-leftover.tmp'), 'ignored');
      git(['add', '--all'], project);
      const tracked = git(['ls-files', '-z'], project)
        .split('\0')
        .filter(Boolean)
        .map((name) => name.normalize('NFC'));
      for (const path of resourcePaths)
        assert.ok(tracked.includes(path.normalize('NFC')), `Git пропустил ${path}`);
      assert.ok(
        !tracked.some(
          (path) =>
            path.startsWith('.agents/.skills-installer-work-') ||
            path === '.skills-installer-operation.lock' ||
            path === '.skills-installer-lock-leftover.tmp',
        ),
      );
      git(['commit', '--quiet', '-m', 'Git roundtrip fixture'], project);
      assert.ok(
        !git(['ls-tree', '-r', 'HEAD'], project).includes('120000 blob'),
        'В проекте не должно быть symlink',
      );
      const name = `${process.platform}-${form}`;
      const bundle = resolve(output, name + '.bundle');
      assert.ok(
        !(await readdir(output)).includes(name + '.bundle'),
        `Bundle уже существует: ${bundle}`,
      );
      git(['bundle', 'create', bundle, 'main'], project);
      const receipt: Receipt = {
        producer: process.platform,
        form,
        commit: git(['rev-parse', 'HEAD'], project).trim(),
        contentHash: record.contentHash,
      };
      await writeFile(resolve(output, name + '.json'), JSON.stringify(receipt, null, 2) + '\n', {
        flag: 'wx',
      });
      console.log(`Produced ${name}: ${receipt.commit}`);
    });
  }
}

/** Снимает inode/mtime обычных файлов обеих копий и lock, чтобы no-op не маскировал переписывание. */
async function installationSnapshot(project: string): Promise<unknown> {
  const paths = [join(project, 'skills-installer-lock.json')];
  for (const base of copies) {
    const root = join(project, base, skill);
    paths.push(root);
    for (const name of await readdir(root, { recursive: true })) paths.push(join(root, name));
  }
  return Promise.all(
    paths.map(async (path) => {
      const stats = await lstat(path, { bigint: true });
      return [path.normalize('NFC'), stats.ino, stats.mtimeNs, stats.size];
    }),
  );
}

/** Проверяет один настоящий checkout: bytes/hash, no-op, manual edits/force и отсутствие внешнего source. */
async function checkCheckout(bundle: string, receipt: Receipt, autocrlf: boolean): Promise<void> {
  await withIsolatedRuntime(async (fixture) => {
    const git = await gitRunner(fixture);
    const project = join(fixture.temporaryRoot, 'Клон с пробелами');
    git(
      [
        'clone',
        '--quiet',
        '--branch',
        'main',
        '--config',
        `core.autocrlf=${autocrlf}`,
        '--config',
        'core.symlinks=false',
        bundle,
        project,
      ],
      fixture.roots.cwd,
    );
    assert.equal(git(['rev-parse', 'HEAD'], project).trim(), receipt.commit);
    assert.equal(git(['config', '--get', 'core.symlinks'], project).trim(), 'false');
    assert.equal(git(['config', '--get', 'core.autocrlf'], project).trim(), String(autocrlf));
    const expected = new Map(
      Object.entries(resources(receipt.form))
        .map(([path, bytes]) => [path.normalize('NFC'), bytes] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    assert.deepEqual(await treeFiles(join(project, 'source')), expected);
    const lockPath = join(project, 'skills-installer-lock.json');
    const lockBytes = await readFile(lockPath);
    const lock = JSON.parse(lockBytes.toString('utf8')) as LockFile;
    assert.equal(lock.skills[skill]!.contentHash, receipt.contentHash);
    await checkCopies(project, expected, receipt.contentHash);
    // Git не переносит пустые папки; executable меняется независимо от bytes/hash.
    for (const base of ['source', ...copies.map((base) => `${base}/${skill}`)]) {
      assert.equal((await readdir(join(project, base))).includes('empty'), false);
      await chmod(join(project, base, 'run.sh'), 0o644);
    }
    const snapshot = await installationSnapshot(project);
    assert.match(cli(fixture, project, ['update', skill, '--yes']), /Без изменений/);
    assert.deepEqual(await installationSnapshot(project), snapshot);
    assert.deepEqual(await readFile(lockPath), lockBytes);
    await checkCopies(project, expected, receipt.contentHash);
    assert.match(cli(fixture, project, ['list']), /external-skill/);
    const externalBefore = await treeFiles(join(project, '.agents/skills/external-skill'));
    assert.match(
      cli(fixture, project, ['update', 'external-skill', '--yes'], 1),
      /Ошибка|не найден|Не удалось/i,
    );
    assert.deepEqual(await readFile(lockPath), lockBytes);
    for (const base of copies)
      assert.deepEqual(await treeFiles(join(project, base, 'external-skill')), externalBefore);
    cli(fixture, project, ['remove', 'external-skill', '--yes']);
    for (const base of copies)
      assert.equal((await readdir(join(project, base))).includes('external-skill'), false);
    for (const base of copies) {
      await writeFile(join(project, base, skill, 'lf.txt'), 'manual edit\r\n');
      const changed = await Promise.all(
        copies.map((base) => treeFiles(join(project, base, skill))),
      );
      const before = await readFile(lockPath);
      cli(fixture, project, ['update', skill, '--yes'], 1);
      assert.deepEqual(await readFile(lockPath), before);
      assert.deepEqual(
        await Promise.all(copies.map((base) => treeFiles(join(project, base, skill)))),
        changed,
      );
      cli(fixture, project, ['update', skill, '--yes', '--force']);
      await checkCopies(project, expected, receipt.contentHash);
    }
    cli(fixture, project, ['remove', skill, '--yes']);
    assert.ok(!cli(fixture, project, ['list']).includes(skill));
    for (const base of copies)
      assert.equal((await readdir(join(project, base))).includes(skill), false);
    assert.deepEqual(await readFile(join(project, 'skills-lock.json')), vercelBytes);
    console.log(
      `Consumed ${receipt.producer}/${receipt.form} -> ${process.platform}, Node ${process.version}, autocrlf=${autocrlf}`,
    );
  });
}

/** Получает bundles из artifact-подкаталогов; отсутствие любого producer/Unicode-варианта — ошибка. */
export async function consumeGitBundles(
  input: string,
  producers = ['linux', 'darwin', 'win32'],
): Promise<void> {
  const bundles: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(path, entry.name));
      else if (entry.name.endsWith('.bundle')) bundles.push(join(path, entry.name));
    }
  }
  await visit(resolve(input));
  assert.equal(bundles.length, producers.length * forms.length, 'Неполный набор bundles');
  const seen = new Set<string>();
  let portableHash: string | undefined;
  for (const bundle of bundles.sort()) {
    const receipt = JSON.parse(
      await readFile(bundle.replace(/\.bundle$/, '.json'), 'utf8'),
    ) as Receipt;
    assert.ok(producers.includes(receipt.producer) && forms.includes(receipt.form));
    portableHash ??= receipt.contentHash;
    assert.equal(
      receipt.contentHash,
      portableHash,
      'Хеш не должен зависеть от producer/Unicode-формы',
    );
    const key = receipt.producer + '/' + receipt.form;
    assert.ok(!seen.has(key), `Повтор producer: ${key}`);
    seen.add(key);
    for (const autocrlf of [false, true]) await checkCheckout(bundle, receipt, autocrlf);
  }
}

/** Выполняет доступное направление без CI artifacts; внешняя fixture владеет локальными bundles. */
export async function localGitRoundtrip(): Promise<void> {
  await withIsolatedRuntime(async (fixture) => {
    const output = join(fixture.temporaryRoot, 'bundles');
    await produceGitBundles(output);
    await consumeGitBundles(output, [process.platform]);
  });
}
