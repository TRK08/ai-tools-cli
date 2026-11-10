import { assertPortableName } from '@/paths';
import { RegistryError } from './errors';
import { isFullSemVer, isRegistrySlug, type RegistryReference } from './reference';

export const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
export const MAX_RELEASE_COMPONENTS = 50;
const CATALOG_PAGE_SIZE = 100;

export interface CatalogSkill {
  readonly packageSlug: string;
  readonly name: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly installName: string;
  readonly size: number;
  readonly sha256: string;
}

export interface CatalogPage {
  readonly items: readonly CatalogSkill[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface PackageRelease {
  readonly slug: string;
  readonly version: string;
  readonly title: string;
  readonly skills: readonly CatalogSkill[];
}

/** Отклоняет неожиданный ответ до использования его идентификаторов или метаданных. */
export function invalidResponse(detail: string): never {
  throw new RegistryError('INVALID_RESPONSE', `Некорректный ответ реестра: ${detail}.`);
}

/** Проверяет форму JSON-объекта до чтения полей ответа. */
export function registryObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalidResponse('ожидался объект');
  return value as Record<string, unknown>;
}

/** Проверяет размер и digest ZIP по ограничениям core. */
export function archiveIdentity(value: unknown): { size: number; sha256: string } {
  const { size, sha256 } = registryObject(value);
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_ARCHIVE_BYTES ||
    typeof sha256 !== 'string' ||
    sha256.length !== 64 ||
    !/^[a-f0-9]+$/.test(sha256)
  )
    invalidResponse('неверный размер или SHA-256 ZIP');
  return { size, sha256 };
}

/** Проверяет идентичность, переносимое installName и данные архива одной записи. */
function skill(value: unknown): CatalogSkill {
  const { packageSlug, kind, name, version, metadata, spec } = registryObject(value);
  const { title, shortDescription } = registryObject(metadata);
  const { installName, archive } = registryObject(spec);
  if (
    typeof packageSlug !== 'string' ||
    !isRegistrySlug(packageSlug) ||
    kind !== 'skill' ||
    typeof name !== 'string' ||
    !isRegistrySlug(name) ||
    typeof version !== 'string' ||
    !isFullSemVer(version) ||
    typeof installName !== 'string' ||
    !isRegistrySlug(installName) ||
    typeof title !== 'string' ||
    typeof shortDescription !== 'string'
  )
    invalidResponse('неверные данные скилла');
  try {
    assertPortableName(installName);
  } catch {
    invalidResponse('непереносимое имя установки скилла');
  }
  return {
    packageSlug,
    name,
    version,
    title,
    description: shortDescription,
    installName,
    ...archiveIdentity(archive),
  };
}

/** Привязывает все скиллы ответа к одному запрошенному релизу и проверяет уникальность. */
export function validateRelease(value: unknown, requested: RegistryReference): PackageRelease {
  const { slug, version, metadata, components } = registryObject(value);
  const { title } = registryObject(metadata);
  if (
    slug !== requested.slug ||
    typeof version !== 'string' ||
    !isFullSemVer(version) ||
    (requested.version !== undefined && requested.version !== version) ||
    typeof title !== 'string' ||
    !Array.isArray(components) ||
    components.length > MAX_RELEASE_COMPONENTS
  )
    invalidResponse('неверная идентичность или состав релиза');
  const skills = components.map(skill);
  if (
    skills.some((item) => item.packageSlug !== slug || item.version !== version) ||
    new Set(skills.map((item) => item.name)).size !== skills.length ||
    new Set(skills.map((item) => item.installName)).size !== skills.length
  )
    invalidResponse('чужие или повторяющиеся компоненты релиза');
  return { slug: requested.slug, version, title, skills };
}

/** Проверяет одну страницу результатов и не смешивает одноимённые скиллы разных пакетов. */
export function validateCatalog(value: unknown): CatalogPage {
  const { items, total, limit, offset } = registryObject(value);
  if (
    !Array.isArray(items) ||
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CATALOG_PAGE_SIZE ||
    items.length > limit ||
    typeof total !== 'number' ||
    !Number.isSafeInteger(total) ||
    total < items.length ||
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (items.length > 0 && offset + items.length > total)
  )
    invalidResponse('неверная страница каталога скиллов');
  const skills = items.map(skill);
  if (new Set(skills.map((item) => `${item.packageSlug}/${item.name}`)).size !== skills.length)
    invalidResponse('повторяющиеся результаты каталога');
  return { items: skills, total, limit, offset };
}
