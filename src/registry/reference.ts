import type { Environment } from '@/runtime';
import { RegistryError } from './errors';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Адаптировано из ../skills/src/registry-source.ts; полная SemVer с build/prerelease.
const numeric = '(?:0|[1-9][0-9]*)';
const pre = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const versionPattern = new RegExp(
  `^${numeric}\\.${numeric}\\.${numeric}(?:-${pre}(?:\\.${pre})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

export interface RegistryReference {
  readonly slug: string;
  readonly version?: string;
}

/** Проверяет slug из строчных латинских букв, цифр и одиночных дефисов без управляющих символов. */
export const isRegistrySlug = (value: string) =>
  value.length <= 64 && !/\p{Cc}/u.test(value) && slugPattern.test(value);
/** Проверяет полную SemVer без префикса v, включая prerelease/build и правила ведущих нулей. */
export const isFullSemVer = (value: string) =>
  value.length <= 128 && !/\p{Cc}/u.test(value) && versionPattern.test(value);

/**
 * Разбирает slug или slug@version, не принимая синтаксис пути/URL.
 *
 * @returns null, если строка не является registry-ссылкой.
 * @throws RegistryError — распознан slug с некорректной явной версией.
 */
export function parseRegistryReference(input: string): RegistryReference | null {
  if (/[/:#\\]/.test(input)) return null;
  const [slug, version, extra] = input.split('@');
  if (!slug || !isRegistrySlug(slug) || extra !== undefined) return null;
  if (version !== undefined && !isFullSemVer(version))
    throw new RegistryError(
      'INVALID_REFERENCE',
      'Версия в реестре должна быть полной версией SemVer без префикса v.',
    );
  return { slug, ...(version === undefined ? {} : { version }) };
}

/**
 * Выбирает URL: явный параметр → SKILLS_API_URL → сохранённая настройка. Сети не касается.
 *
 * @throws RegistryError — URL не является базовым HTTP(S) адресом или содержит учётные данные, query либо
 * fragment.
 */
export function getRegistryUrl(
  explicit: string | undefined,
  env: Environment,
  saved?: string,
): string {
  const input = explicit?.trim() || env.SKILLS_API_URL?.trim() || saved?.trim();
  if (!input)
    throw new RegistryError(
      'INVALID_REGISTRY',
      'Реестр не настроен. Выполните skills-installer config set registry https://registry.example или укажите --registry / SKILLS_API_URL.',
    );
  try {
    const url = new URL(input);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      /[?#\p{Cc}]/u.test(input)
    )
      throw new Error('Некорректный базовый URL.');
    return url.href.replace(/\/+$/, '');
  } catch (cause) {
    throw new RegistryError(
      'INVALID_REGISTRY',
      'URL реестра должен быть базовым HTTP(S) URL без учётных данных, параметров и фрагмента.',
      { cause },
    );
  }
}
