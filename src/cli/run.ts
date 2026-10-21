import { CommanderError } from 'commander';
import { errorMessage } from '../errors.ts';
import { createProgram } from './program.ts';
import type { CliContext } from './types.ts';

/** Запускает CLI с явными argv/потоками; возвращает exit 0/1, итоговую ошибку пишет в stderr. */
export async function executeCli(context: CliContext, args: readonly string[]): Promise<number> {
  const program = createProgram(context);
  for (const command of [program, ...program.commands]) command.exitOverride();
  try {
    await program.parseAsync([...args], { from: 'user' });
    return 0;
  } catch (error) {
    // Commander уже вывел свою справку или диагностику в настроенный поток.
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 1;
    const message = errorMessage(error);
    context.stderr.write(`${message.startsWith('Ошибка:') ? message : `Ошибка: ${message}`}\n`);
    return 1;
  }
}
