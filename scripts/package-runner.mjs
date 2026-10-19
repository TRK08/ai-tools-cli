import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

/**
 * Экранирует аргумент для cmd и второго разбора %* внутри npm .cmd shim.
 * Алгоритм адаптирован из @npmcli/promise-spawn/lib/escape.js (ISC), см. ThirdPartyNoticeText.txt.
 */
export function quoteCmdArgument(value, doubleEscape = true) {
  if (/[\r\n\0]/.test(value)) throw new Error('Недопустимый перевод строки/NUL в аргументе cmd');
  if (!value) return '""';
  let quoted = value;
  if (/[\s"]/.test(value)) {
    quoted = '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  }
  const escape = (text) => text.replace(/[ !%^&()<>|"]/g, '^$&');
  return doubleEscape ? escape(escape(quoted)) : escape(quoted);
}

/** Создаёт runner с явным env; npm запускается тем же Node по npm_execpath от npm run. */
export function packageRunner(env, npmExecPath, platform = process.platform) {
  if (!npmExecPath)
    throw new Error('Запустите проверку через npm run package:smoke (нужен npm_execpath).');
  const options = (cwd) => ({
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    /** Запускает npm CLI без shell и без поиска npm.cmd/npm.ps1 в PATH. */
    npm(args, cwd) {
      return execFileSync(process.execPath, [npmExecPath, ...args], options(cwd));
    },
    /** Запускает реальный установленный executable либо Windows .cmd с явным quoting. */
    bin(bin, args, cwd) {
      if (platform !== 'win32') return execFileSync(bin, args, options(cwd));
      const command =
        '"' +
        [quoteCmdArgument(bin, false), ...args.map((arg) => quoteCmdArgument(arg))].join(' ') +
        '"';
      return execFileSync(
        env.ComSpec ?? join(env.SystemRoot, 'System32', 'cmd.exe'),
        ['/d', '/s', '/v:off', '/c', command],
        {
          ...options(cwd),
          // npm shim ищет node в PATH, поэтому первым доступен тот же Node, что запускает smoke.
          env: { ...env, PATH: dirname(process.execPath) + ';' + (env.PATH ?? '') },
          windowsVerbatimArguments: true,
        },
      );
    },
  };
}
