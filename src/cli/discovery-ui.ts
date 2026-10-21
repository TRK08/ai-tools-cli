import type { Writable } from 'node:stream';
import type { CatalogSkill } from '../registry/catalog.ts';
import { renderTable } from './terminal/table.ts';

/** Печатает результаты серверного поиска без установки; пустой список показывает отдельным сообщением. */
export function renderSearch(
  skills: readonly CatalogSkill[],
  output: Writable & { readonly columns?: number },
): void {
  if (!skills.length) {
    output.write('Скиллы не найдены.\n');
    return;
  }
  renderTable(
    [
      { title: 'Slug', maximum: 36 },
      { title: 'Версия', maximum: 24 },
      { title: 'Установок', maximum: 16 },
    ],
    skills.map((skill) => [skill.slug, skill.currentVersion, String(skill.installCount)]),
    output,
  );
  output.write(`Найдено скиллов: ${skills.length}.\n`);
}
