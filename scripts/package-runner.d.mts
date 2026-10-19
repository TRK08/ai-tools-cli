/** Экранирует один аргумент cmd; второй проход нужен для %* npm shim. CR/LF/NUL запрещены. */
export function quoteCmdArgument(value: string, doubleEscape?: boolean): string;
/** Создаёт npm/bin runner с изолированным env; npmExecPath обязателен. */
export function packageRunner(
  env: Record<string, string>,
  npmExecPath?: string,
  platform?: string,
): {
  npm(args: string[], cwd: string): string;
  bin(bin: string, args: string[], cwd: string): string;
};
