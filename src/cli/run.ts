import { isCancellation } from '@/cancellation';
import { CommanderError } from 'commander';
import { errorMessage } from '@/errors';
import { createProgram } from './program';
import type { CliContext } from './types';

/**
 * Запускает CLI с единым сигналом SIGINT/SIGTERM; повторные сигналы идемпотентны.
 * Возвращает 0/1 только после отката/очистки, освобождает свои listeners, ошибку пишет в stderr.
 */
export async function executeCli(context: CliContext, args: readonly string[]): Promise<number> {
  const controller = new AbortController();
  const signal = context.runtime.signal
    ? AbortSignal.any([context.runtime.signal, controller.signal])
    : controller.signal;
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  const program = createProgram({ ...context, runtime: { ...context.runtime, signal } });
  const override = (command: typeof program) => {
    command.exitOverride();
    command.commands.forEach(override);
  };
  override(program);
  try {
    await program.parseAsync([...args], { from: 'user' });
    return 0;
  } catch (error) {
    if (isCancellation(error, signal)) {
      context.stdout.write('Отменено.\n');
      return 0;
    }
    // Commander уже вывел свою справку или диагностику в настроенный поток.
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 1;
    const message = errorMessage(error);
    context.stderr.write(`${message.startsWith('Ошибка:') ? message : `Ошибка: ${message}`}\n`);
    return 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
