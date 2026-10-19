/**
 * Создаёт fixture npm smoke: установки с пробелами/кириллицей, cwd/source с метасимволами.
 * Учитывает ограничение пути npm shim; очисткой временного root владеет вызывающий.
 */
export function preparePackageFixture(root: string): Promise<{
  localInstall: string;
  prefix: string;
  project: string;
  source: string;
}>;
