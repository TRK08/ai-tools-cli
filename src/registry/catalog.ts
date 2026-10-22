import { RegistryError } from './errors';
import { isFullSemVer, isRegistrySlug } from './reference';

export interface CatalogSkill {
  readonly slug: string;
  readonly name: string;
  readonly shortDescription: string;
  readonly tags: readonly string[];
  readonly currentVersion: string;
  readonly installCount: number;
}

export interface SkillDetail extends CatalogSkill {
  readonly longDescription: string;
  readonly version: string;
  readonly versions: readonly string[];
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new RegistryError('INVALID_RESPONSE', 'Реестр вернул некорректные метаданные каталога.');
  return value as Record<string, unknown>;
}

/** Проверяет поля одного результата registry и возвращает неизменяемую копию метаданных. */
export function validateCatalogSkill(value: unknown): CatalogSkill {
  const data = object(value);
  if (
    typeof data.slug !== 'string' ||
    !isRegistrySlug(data.slug) ||
    typeof data.name !== 'string' ||
    typeof data.shortDescription !== 'string' ||
    !Array.isArray(data.tags) ||
    !data.tags.every((tag) => typeof tag === 'string') ||
    typeof data.currentVersion !== 'string' ||
    !isFullSemVer(data.currentVersion) ||
    typeof data.installCount !== 'number' ||
    !Number.isSafeInteger(data.installCount) ||
    data.installCount < 0
  )
    throw new RegistryError('INVALID_RESPONSE', 'Реестр вернул некорректные поля каталога.');
  return Object.freeze({
    slug: data.slug,
    name: data.name,
    shortDescription: data.shortDescription,
    tags: Object.freeze([...data.tags] as string[]),
    currentVersion: data.currentVersion,
    installCount: data.installCount,
  });
}

/** Проверяет ответ каталога и каждую запись items; неверный ответ не считается пустым поиском. */
export function validateCatalog(value: unknown): readonly CatalogSkill[] {
  const data = object(value);
  if (!Array.isArray(data.items))
    throw new RegistryError('INVALID_RESPONSE', 'Каталог реестра должен содержать массив items.');
  return Object.freeze(data.items.map(validateCatalogSkill));
}

/** Проверяет карточку, соответствие slug/выбранной версии и список доступных версий. */
export function validateSkillDetail(value: unknown, slug: string, version?: string): SkillDetail {
  const data = object(value);
  const skill = validateCatalogSkill(value);
  if (
    skill.slug !== slug ||
    typeof data.longDescription !== 'string' ||
    typeof data.version !== 'string' ||
    (version !== undefined && data.version !== version) ||
    !isFullSemVer(data.version) ||
    !Array.isArray(data.versions) ||
    !data.versions.every((version) => typeof version === 'string' && isFullSemVer(version)) ||
    !data.versions.includes(data.currentVersion) ||
    !data.versions.includes(data.version)
  )
    throw new RegistryError('INVALID_RESPONSE', 'Реестр вернул некорректные поля карточки скилла.');
  return Object.freeze({
    ...skill,
    longDescription: data.longDescription,
    version: data.version,
    versions: Object.freeze([...data.versions] as string[]),
  });
}

/** Возвращает новый список по убыванию installCount, затем по slug; исходный массив сохраняет. */
export function sortCatalog(items: readonly CatalogSkill[]): readonly CatalogSkill[] {
  return [...items].sort((a, b) => b.installCount - a.installCount || a.slug.localeCompare(b.slug));
}
