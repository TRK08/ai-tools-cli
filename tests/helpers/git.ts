import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestEnvironment } from './test-environment.ts';

type Git = (args: string[], cwd: string) => string;

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
export async function createGitRunner(fixture: TestEnvironment): Promise<Git> {
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
