import { AGENTS, agentConnectionKind, isAgentId, type AgentId } from '@/agents';
import { getRegistryUrl, isFullSemVer, isRegistrySlug, MAX_RELEASE_COMPONENTS } from '@/registry';
import { StateError } from '@/errors';
import {
  assertSkillName,
  getSkillDirectory,
  portableConnectionPath,
  validatePortablePathText,
  validatePathText,
  type StatePaths,
} from './paths';
import { assertPortableNames, isPathWithin, nativePath, pathIdentityKey } from '@/paths';
import {
  LOCK_VERSION,
  type InstalledPackage,
  type InstalledSkill,
  type LockFile,
  type ManagedConnection,
} from './types';

function invalid(message: string): never {
  throw new StateError('INVALID_LOCK', message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(`${label} должен быть объектом.`);
  return value as Record<string, unknown>;
}

/** Проверяет наличие обязательных и отсутствие неизвестных полей объекта lock. */
function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    invalid(`Некорректные поля; ожидаются ${[...required, ...optional].join(', ')}.`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /\p{Cc}/u.test(value))
    invalid(`${label} должен быть непустой строкой без управляющих символов.`);
  return value;
}

/** Проверяет SHA-256 в шестнадцатеричной форме и нормализует регистр для сохранения. */
function digest(value: unknown, label: string): string {
  const hash = text(value, label);
  if (!/^[a-f\d]{64}$/i.test(hash))
    invalid(`${label} должен быть хешем SHA-256 в шестнадцатеричном формате.`);
  return hash.toLowerCase();
}

/** Проверяет идентификатор агента по общему каталогу; неизвестное значение даёт INVALID_LOCK. */
function agent(value: unknown): AgentId {
  if (!isAgentId(value)) invalid(`Неизвестный агент: ${JSON.stringify(value)}.`);
  return value;
}

/** Проверяет агент/вид по единому каталогу и кодирует путь подключения по правилам области. */
function connection(value: unknown, paths: StatePaths, storageInput: boolean): ManagedConnection {
  const entry = object(value, 'connection');
  keys(entry, ['agent', 'path', 'kind']);
  const id = agent(entry.agent);
  const kind = agentConnectionKind(id, paths.scope);
  if (entry.kind !== kind) invalid('Вид подключения не соответствует агенту и области.');
  const path = text(entry.path, 'connection.path');
  if (!storageInput && paths.scope === 'project') validatePortablePathText(path);
  else validatePathText(path);
  if (!storageInput && nativePath.isAbsolute(path) !== (paths.scope === 'global'))
    invalid(
      'Сохранённый путь подключения должен быть относительным в проекте и абсолютным в глобальной области.',
    );
  return { agent: id, path: portableConnectionPath(path, paths), kind };
}

/** Строит ключ владения назначением, сохраняя исходную строку пути в записи lock. */
function connectionKey(path: string, paths: StatePaths): string {
  return pathIdentityKey(nativePath.resolve(paths.cwd, path));
}

/** Проверяет хеши и пути скилла по каталогу агентов; сохранённый глобальный путь не зависит от текущего env. */
function skill(value: unknown, paths: StatePaths, storageInput: boolean): InstalledSkill {
  const entry = object(value, 'skill');
  keys(entry, ['name', 'installName', 'contentHash', 'archiveHash', 'connections']);
  const name = text(entry.name, 'name');
  const installName = text(entry.installName, 'installName');
  assertSkillName(installName);
  if (!isRegistrySlug(name) || !isRegistrySlug(installName))
    invalid('Некорректное имя компонента или каталога установки.');
  if (!Array.isArray(entry.connections) || !entry.connections.length)
    invalid('В записи скилла нужно хотя бы одно подключение.');
  const connections = entry.connections.map((item) => connection(item, paths, storageInput));
  if (new Set(connections.map((item) => item.agent)).size !== connections.length)
    invalid('Агент может иметь только одно подключение к скиллу.');
  const shared = getSkillDirectory(paths, installName);
  for (const item of connections) {
    const absolute = nativePath.resolve(paths.cwd, item.path);
    if (
      item.kind === 'direct'
        ? connectionKey(absolute, paths) !== connectionKey(shared, paths)
        : isPathWithin(paths.skillsDirectory, absolute) ||
          nativePath.basename(absolute) !== installName
    )
      invalid('Управляемый путь не соответствует имени установки и типу подключения.');
  }
  if (
    paths.scope === 'project' &&
    connections.some(
      (item) =>
        item.kind === 'link' &&
        connectionKey(item.path, paths) !==
          connectionKey(
            nativePath.join(
              AGENTS.find((agent) => agent.id === item.agent)!.project.directory(paths),
              installName,
            ),
            paths,
          ),
    )
  )
    invalid('Проектное подключение должно находиться в каталоге своего агента.');
  return {
    name,
    installName,
    contentHash: digest(entry.contentHash, 'contentHash'),
    archiveHash: digest(entry.archiveHash, 'archiveHash'),
    connections: connections.sort((a, b) => a.agent.localeCompare(b.agent)),
  };
}

/** Проверяет одну версию, канонический URL и уникальный установленный состав пакета. */
function installedPackage(
  value: unknown,
  paths: StatePaths,
  storageInput: boolean,
): InstalledPackage {
  const entry = object(value, 'package');
  keys(entry, ['slug', 'registryUrl', 'version', 'skills']);
  const slug = text(entry.slug, 'slug');
  const version = text(entry.version, 'version');
  const url = text(entry.registryUrl, 'registryUrl');
  let registryUrl: string;
  try {
    registryUrl = getRegistryUrl(url, {});
  } catch {
    invalid('Некорректный базовый URL реестра.');
  }
  if (
    !isRegistrySlug(slug) ||
    !isFullSemVer(version) ||
    !Array.isArray(entry.skills) ||
    !entry.skills.length ||
    entry.skills.length > MAX_RELEASE_COMPONENTS
  )
    invalid('Некорректный пакет, версия или установленный состав.');
  const skills = entry.skills.map((item) => skill(item, paths, storageInput));
  if (new Set(skills.map((item) => item.name)).size !== skills.length)
    invalid('Имена компонентов в пакете должны быть уникальны.');
  return {
    slug,
    registryUrl,
    version,
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Проверяет lock version: 1 и эксклюзивное владение общими каталогами и путями агентов. */
function normalize(value: unknown, paths: StatePaths, storageInput: boolean): LockFile {
  try {
    const lock = object(value, 'lock');
    if (lock.version !== LOCK_VERSION)
      invalid('Некорректная структура файла состояния: ожидается version: 1.');
    keys(lock, ['version', 'packages']);
    if (!Array.isArray(lock.packages)) invalid('Поле packages должно быть массивом.');
    const packages = lock.packages.map((entry) => installedPackage(entry, paths, storageInput));
    if (new Set(packages.map((entry) => entry.slug)).size !== packages.length)
      invalid('В области может быть только одна запись для пакета.');
    const skills = packages.flatMap((entry) => entry.skills);
    assertPortableNames(skills.map((entry) => entry.installName));
    const managedPaths = new Set<string>();
    for (const entry of skills) {
      for (const connection of entry.connections) {
        if (connection.kind === 'direct') continue;
        const key = connectionKey(connection.path, paths);
        if (managedPaths.has(key)) invalid('Разные подключения не могут управлять одним путём.');
        managedPaths.add(key);
      }
    }
    return {
      version: LOCK_VERSION,
      packages: packages.sort((a, b) => a.slug.localeCompare(b.slug)),
    };
  } catch (cause) {
    if (cause instanceof StateError && cause.code === 'INVALID_PATH') {
      throw new StateError('INVALID_LOCK', cause.message, { cause });
    }
    throw cause;
  }
}

/**
 * Строго проверяет сохранённый lock и возвращает нормализованное состояние. Абсолютные пути текущей
 * машины не допускаются в проектном lock; неверная/неизвестная схема — ошибка.
 */
export function parseLockFile(value: unknown, paths: StatePaths): LockFile {
  return normalize(value, paths, false);
}

/**
 * Проверяет runtime-состояние, кодирует переносимые пути и возвращает детерминированный JSON. На диск не
 * записывает; абсолютные runtime-пути проекта преобразуются в относительные.
 */
export function serializeLockFile(lock: LockFile, paths: StatePaths): string {
  return `${JSON.stringify(normalize(lock, paths, true), null, 2)}\n`;
}
