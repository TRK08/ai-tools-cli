import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { create as createTar } from 'tar';

/**
 * Готовит npm-архив с executable-битами объявленного bin независимо от прав исходника.
 * Npm выбирает файлы; tar перепаковывает их без извлечения и меняет только mode bin.
 * Возвращает промежуточный tgz для последующих npm pack/проверок с пересчётом метаданных.
 * Все ресурсы находятся в temporaryDirectory; их очисткой при любом исходе владеет вызывающий.
 * @param binPath - Относительный POSIX-путь bin из manifest без начального ./.
 * @throws Если в архиве нет ровно одного обычного файла bin или упаковка завершилась ошибкой.
 */
export async function preparePackageArchive(runner, cwd, temporaryDirectory, binPath) {
  const directory = await mkdtemp(join(temporaryDirectory, 'npm-pack-'));
  const [raw] = JSON.parse(
    runner.npm(['pack', '--json', '--ignore-scripts', '--pack-destination', directory], cwd),
  );
  const archive = join(directory, 'prepared.tgz');
  let bins = 0;
  await createTar(
    {
      file: archive,
      gzip: true,
      portable: true,
      strict: true,
      onWriteEntry(entry) {
        if (entry.path === `package/${binPath}` && entry.type === 'File') {
          entry.mode |= 0o111;
          bins++;
        }
      },
    },
    ['@' + join(directory, raw.filename)],
  );
  if (bins !== 1) throw new Error(`В npm-архиве ожидался один обычный bin: ${binPath}.`);
  return archive;
}
