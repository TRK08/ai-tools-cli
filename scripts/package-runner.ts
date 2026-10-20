import { execFileSync } from 'node:child_process';
import type { ExecFileSyncOptionsWithStringEncoding, SpawnSyncOptions } from 'node:child_process';
import { dirname, join } from 'node:path';

/**
 * Экранирует аргумент для cmd и второго разбора %* внутри npm .cmd shim.
 * Алгоритм адаптирован из @npmcli/promise-spawn/lib/escape.js (ISC), см. ThirdPartyNoticeText.txt.
 * @throws Если аргумент содержит CR, LF или NUL.
 */
export function quoteCmdArgument(value: string, doubleEscape = true) {
  if (/[\r\n\0]/.test(value)) throw new Error('Недопустимый перевод строки/NUL в аргументе cmd');
  if (!value) return '""';
  let quoted = value;
  if (/[\s"]/.test(value)) {
    quoted = '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  }
  const escape = (text: string) => text.replace(/[ !%^&()<>|"]/g, '^$&');
  return doubleEscape ? escape(escape(quoted)) : escape(quoted);
}

/**
 * Создаёт runner с явным env; npm запускается тем же Node по npm_execpath от npm run.
 * @throws Если npmExecPath отсутствует; дочерние команды передают ошибки и timeout вызывающему.
 */
export function packageRunner(
  env: Record<string, string>,
  npmExecPath?: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (!npmExecPath)
    throw new Error('Запустите проверку через npm run package:smoke (нужен npm_execpath).');
  const options = (cwd: string): ExecFileSyncOptionsWithStringEncoding => ({
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    /** Запускает npm CLI без shell и без поиска npm.cmd/npm.ps1 в PATH. */
    npm(args: string[], cwd: string) {
      return execFileSync(process.execPath, [npmExecPath, ...args], options(cwd));
    },
    /** Запускает реальный установленный executable либо Windows .cmd с явным quoting. */
    bin(bin: string, args: string[], cwd: string) {
      if (platform !== 'win32') return execFileSync(bin, args, options(cwd));
      const command =
        '"' +
        [quoteCmdArgument(bin, false), ...args.map((arg) => quoteCmdArgument(arg))].join(' ') +
        '"';
      // execFileSync передаёт эту настройку spawnSync; @types/node не включает её в exec options.
      const cmdOptions = {
        ...options(cwd),
        // npm shim ищет node в PATH, поэтому первым доступен тот же Node, что запускает smoke.
        env: { ...env, PATH: dirname(process.execPath) + ';' + (env.PATH ?? '') },
        windowsVerbatimArguments: true,
      } satisfies ExecFileSyncOptionsWithStringEncoding &
        Pick<SpawnSyncOptions, 'windowsVerbatimArguments'>;
      return execFileSync(
        env.ComSpec ?? join(env.SystemRoot!, 'System32', 'cmd.exe'),
        ['/d', '/s', '/v:off', '/c', command],
        cmdOptions,
      );
    },
  };
}
