import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RuntimeContext } from '@/runtime';

const tsconfig = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));

const cliArguments = (args: readonly string[]) => [
  '--import',
  import.meta.resolve('tsx'),
  fileURLToPath(new URL('../../src/cli.ts', import.meta.url)),
  ...args,
];

/** Запускает исходный CLI с явным tsconfig независимо от cwd; закрывает stdin, timeout — ошибка. */
export async function runCli(context: RuntimeContext, args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, cliArguments(args), {
        cwd: context.roots.cwd,
        env: { ...context.env, TSX_DISABLE_CACHE: '1', TSX_TSCONFIG_PATH: tsconfig },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data;
      });
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      child.on('error', reject);
      child.on('close', (status, signal) => {
        if (signal) reject(new Error(`CLI terminated by ${signal}`));
        else resolve({ status, stdout, stderr });
      });
      child.stdin.end();
    },
  );
}

/** Синхронный запуск с явным tsconfig без HTTP-сервера; ненормальное завершение бросает ошибку. */
export function runCliSync(context: RuntimeContext, args: string[]) {
  const result = spawnSync(process.execPath, cliArguments(args), {
    cwd: context.roots.cwd,
    env: { ...context.env, TSX_DISABLE_CACHE: '1', TSX_TSCONFIG_PATH: tsconfig },
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`CLI terminated by ${result.signal}`);
  return result;
}
