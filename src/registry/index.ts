/** Клиент registry и проверенные ссылки пакетов. Импорт не выполняет I/O. */
export { MAX_RELEASE_COMPONENTS } from './catalog';
export type { CatalogPage, CatalogSkill, PackageRelease } from './catalog';
export { RegistryClient } from './client';
export { RegistryError } from './errors';
export { getRegistryUrl, isFullSemVer, isRegistrySlug, parseRegistryReference } from './reference';
export type { RegistryReference } from './reference';
