import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Создаёт каталоги npm smoke внутри временного root; очисткой владеет вызывающий.
 * Пути установки bin содержат пробелы/кириллицу, но не метасимволы cmd: npm shim
 * использует SET dp0=%~dp0 без кавычек (npm/cmd-shim#45). Сложные cwd и source
 * проверяются отдельно от пути самого shim, через настоящий установленный bin.
 */
export async function preparePackageFixture(root) {
  const paths = {
    localInstall: join(root, 'Локальная npm установка'),
    prefix: join(root, 'Глобальный npm prefix'),
    project: join(root, 'Проект & (проверка) %PATH% ! ^'),
    source: join(root, 'Источник & (скилл) %PATH% ! ^'),
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  return paths;
}
