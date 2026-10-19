/**
 * Готовит npm-архив с executable-mode bin; исходники не меняет и ничего не извлекает.
 * Возвращает промежуточный tgz; очисткой temporaryDirectory при любом исходе владеет вызывающий.
 * @param binPath - Относительный POSIX-путь bin из manifest без начального ./.
 */
export function preparePackageArchive(
  runner: { npm(args: string[], cwd: string): string },
  cwd: string,
  temporaryDirectory: string,
  binPath: string,
): Promise<string>;
