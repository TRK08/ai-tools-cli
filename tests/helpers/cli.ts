import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RuntimeContext } from '../../src/runtime.ts';

export async function runCli(context: RuntimeContext, args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          fileURLToPath(new URL('../../src/cli.ts', import.meta.url)),
          ...args,
        ],
        {
          cwd: context.roots.cwd,
          env: { ...context.env, TSX_DISABLE_CACHE: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10_000,
        },
      );
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
