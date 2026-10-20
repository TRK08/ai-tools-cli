import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';

const systemKeys = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']);
const canonicalKeys: Record<string, string> = {
  SYSTEMROOT: 'SystemRoot',
  WINDIR: 'windir',
  COMSPEC: 'ComSpec',
};

export type IsolatedRuntime = Awaited<ReturnType<typeof prepareIsolatedRuntime>> & {
  readonly temporaryRoot: string;
};

/**
 * Собирает env по системному allowlist, нормализуя имена без учёта регистра.
 * Явные настройки допустимы, но профили, npm-конфигурация, tmp и telemetry принадлежат fixture.
 * NODE_OPTIONS/NODE_PATH и унаследованные npm-настройки в дочерние процессы не попадают.
 */
export function isolatedEnvironment(
  root: string,
  overrides: Record<string, string | undefined> = {},
  ambient: NodeJS.ProcessEnv = process.env,
) {
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(ambient)) {
    if (value !== undefined && systemKeys.has(key.toUpperCase()))
      values.set(key.toUpperCase(), value);
  }
  for (const [key, value] of Object.entries(overrides)) {
    const normalized = key.toUpperCase();
    if (
      value !== undefined &&
      !/^NPM_/i.test(key) &&
      !['NODE_OPTIONS', 'NODE_PATH'].includes(normalized)
    )
      values.set(normalized, value);
  }
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  const drive = parse(home).root.replace(/[\\/]$/, '');
  const protectedValues = {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: drive,
    HOMEPATH: home.slice(drive.length),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_RUNTIME_DIR: join(root, 'run'),
    XDG_CONFIG_DIRS: join(root, 'config'),
    XDG_DATA_DIRS: join(root, 'data'),
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    NPM_CONFIG_USERCONFIG: join(root, 'user.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: join(root, 'global.npmrc'),
    NPM_CONFIG_CACHE: join(root, 'npm-cache'),
    NPM_CONFIG_PREFIX: join(root, 'npm-prefix'),
    TSX_DISABLE_CACHE: '1',
    DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
  };
  for (const [key, value] of Object.entries(protectedValues)) values.set(key, value);
  return Object.fromEntries(
    [...values].map(([key, value]) => [
      canonicalKeys[key] ?? (key.startsWith('NPM_CONFIG_') ? key.toLowerCase() : key),
      value,
    ]),
  );
}

/** Создаёт все каталоги sandbox и пустые npmrc; очисткой полученного root владеет вызывающий. */
export async function prepareIsolatedRuntime(root: string, overrides: Record<string, string> = {}) {
  const env = isolatedEnvironment(root, overrides);
  const directories = [
    join(root, 'project'),
    ...Object.entries(env)
      .filter(([key]) =>
        /^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|XDG_((CONFIG|DATA|STATE|CACHE)_HOME|RUNTIME_DIR|(CONFIG|DATA)_DIRS)|CODEX_HOME|CLAUDE_CONFIG_DIR|npm_config_(cache|prefix))$/.test(
          key,
        ),
      )
      .map(([, value]) => value),
  ];
  await Promise.all([...new Set(directories)].map((path) => mkdir(path, { recursive: true })));
  await Promise.all(
    [env.npm_config_userconfig, env.npm_config_globalconfig].map((path) =>
      writeFile(path!, '', { flag: 'wx' }),
    ),
  );
  return { roots: { cwd: join(root, 'project'), home: env.HOME! }, env };
}

/**
 * Выполняет callback в собственных cwd/home/tmp/npm, затем удаляет root с ограниченными retry.
 * При совместном отказе callback и очистки AggregateError сохраняет исходную причину и путь root.
 */
export async function withIsolatedRuntime<T>(
  run: (runtime: IsolatedRuntime) => Promise<T>,
  overrides: Record<string, string> = {},
) {
  const created = await mkdtemp(join(tmpdir(), 'skills-installer-'));
  let failure: unknown;
  let result!: T;
  try {
    const temporaryRoot = await realpath(created);
    const runtime = await prepareIsolatedRuntime(temporaryRoot, overrides);
    result = await run({ temporaryRoot, ...runtime });
  } catch (cause) {
    failure = cause;
  }
  try {
    await rm(created, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (cleanup) {
    if (failure !== undefined)
      throw new AggregateError([failure, cleanup], `Не удалось очистить ${created}`, {
        cause: failure,
      });
    throw cleanup;
  }
  if (failure !== undefined) throw failure;
  return result;
}
