import type { CatalogPage } from '@/registry';
import type { PromptStreams } from '@/cli/terminal';

/** Выводит идентичность каждого результата и готовую команду установки одного скилла. */
export function renderSearch(
  page: CatalogPage,
  registryUrl: string,
  flags: readonly string[],
  output: PromptStreams['output'],
): void {
  const { items, total } = page;
  output.write(`Найдено: ${total}. Показано: ${items.length}.\n`);
  if (!items.length) {
    output.write('Скиллы не найдены.\n');
    return;
  }
  // Базовый URL может содержать пробелы и shell-метасимволы в пути.
  const registry = /^[a-zA-Z0-9:/._-]+$/.test(registryUrl)
    ? registryUrl
    : "'" + registryUrl.replaceAll("'", "'\\''") + "'";
  for (const item of items) {
    output.write(`${item.name}  ${item.packageSlug}  ${item.version}\n`);
    output.write(
      `  skills-installer add ${item.packageSlug}@${item.version} --skill ${item.name} --registry ${registry} ${flags.join(' ')}\n`,
    );
  }
}
