import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RuntimeContext } from '../../src/runtime.ts';

const entry = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));

/** Проверяет готовую сборку; отсутствие dist — ошибка с командой подготовки, а не пропуск e2e. */
export async function requireBuiltCli(): Promise<void> {
  await access(entry).catch((cause) => {
    throw new Error('Перед e2e выполните npm run build.', { cause });
  });
}

/** Запускает настоящий dist без shell/tsx в изолированном cwd/home/env; закрывает stdin и ждёт выхода. */
export async function runBuiltCli(context: RuntimeContext, args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [entry, ...args], {
        cwd: context.roots.cwd,
        env: context.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15_000,
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (status, signal) => {
        if (signal) reject(new Error(`CLI terminated by ${signal}: ${stderr}`));
        else resolve({ status, stdout, stderr });
      });
      child.stdin.end();
    },
  );
}
