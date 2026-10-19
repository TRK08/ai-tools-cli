import { isAgentId, isDirectAgent } from '../agents/catalog.ts';
import type { AgentId } from '../installer/types.ts';
import type { SourceIdentity } from '../sources/types.ts';
import { isFullSemVer, isRegistrySlug } from '../registry/reference.ts';
import { StateError } from './errors.ts';
import { normalizeRegistryUrl } from './identity.ts';
import {
  assertSkillName,
  getSkillDirectory,
  portableConnectionPath,
  portableSourcePath,
  validatePortablePathText,
  validatePathText,
  type StatePaths,
} from './paths.ts';
import { assertPortableNames } from './names.ts';
import { nativePath, pathIdentityKey } from './native-path.ts';
import {
  LOCK_VERSION,
  type InstallationRecord,
  type LockFile,
  type ManagedConnection,
} from './types.ts';

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

/**
 * Проверяет и нормализует постоянный источник, не принимая временные URL.
 *
 * @param storageInput - true допускает runtime-пути при сериализации; false проверяет сохранённый формат.
 */
function source(value: unknown, paths: StatePaths, storageInput: boolean): SourceIdentity {
  const entry = object(value, 'source');
  if (entry.kind === 'registry') {
    keys(entry, ['kind', 'registryUrl', 'slug']);
    const slug = text(entry.slug, 'slug');
    assertSkillName(slug);
    if (!isRegistrySlug(slug))
      invalid('Slug реестра должен содержать строчные латинские буквы, цифры и одиночные дефисы.');
    return {
      kind: 'registry',
      registryUrl: normalizeRegistryUrl(text(entry.registryUrl, 'registryUrl')),
      slug,
    };
  }
  if (entry.kind !== 'directory' && entry.kind !== 'archive')
    invalid('Неподдерживаемый тип источника.');
  keys(entry, ['kind', 'path']);
  const path = text(entry.path, 'source.path');
  if (!storageInput && paths.scope === 'project') validatePortablePathText(path);
  else validatePathText(path);
  if (!storageInput && nativePath.isAbsolute(path) !== (paths.scope === 'global'))
    invalid(
      'Сохранённый путь локального источника должен быть относительным в проекте и абсолютным в глобальной области.',
    );
  return { kind: entry.kind, path: portableSourcePath(path, paths) };
}

/** Проверяет агент/путь управляемого подключения и кодирует путь по правилам области. */
function connection(value: unknown, paths: StatePaths, storageInput: boolean): ManagedConnection {
  const entry = object(value, 'connection');
  keys(entry, ['agent', 'path']);
  const path = text(entry.path, 'connection.path');
  if (!storageInput && paths.scope === 'project') validatePortablePathText(path);
  else validatePathText(path);
  if (!storageInput && nativePath.isAbsolute(path) !== (paths.scope === 'global'))
    invalid(
      'Сохранённый путь подключения должен быть относительным в проекте и абсолютным в глобальной области.',
    );
  return { agent: agent(entry.agent), path: portableConnectionPath(path, paths) };
}

/** Строит ключ владения назначением, сохраняя исходную строку пути в записи lock. */
function connectionKey(path: string, paths: StatePaths): string {
  return pathIdentityKey(nativePath.resolve(paths.cwd, path));
}

/** Проверяет одну запись lock: имя, источник/политику, версии, хеши и согласованность подключений. */
function record(
  value: unknown,
  name: string,
  paths: StatePaths,
  storageInput: boolean,
): InstallationRecord {
  assertSkillName(name);
  const entry = object(value, `skills.${name}`);
  keys(
    entry,
    ['name', 'source', 'version', 'policy', 'contentHash', 'agents', 'connections'],
    ['archiveHash'],
  );
  if (entry.name !== name)
    invalid('Ключ скилла в файле состояния должен совпадать с именем записи.');
  const identity = source(entry.source, paths, storageInput);
  const version = entry.version === null ? null : text(entry.version, 'version');
  const policy = entry.policy;
  if (identity.kind === 'registry') {
    if (
      !['latest', 'exact'].includes(policy as string) ||
      version === null ||
      !isFullSemVer(version)
    )
      invalid('Запись из реестра должна содержать версию и политику latest/exact.');
    if (identity.slug !== name) invalid('Slug реестра должен совпадать с именем скилла.');
  } else if (policy !== 'local') invalid('Для локальных записей требуется политика local.');
  if (!Array.isArray(entry.agents) || entry.agents.length === 0)
    invalid('В записи требуется хотя бы один агент.');
  const desiredAgents = entry.agents.map(agent);
  if (new Set(desiredAgents).size !== desiredAgents.length)
    invalid('Повторяющиеся агенты недопустимы.');
  if (!Array.isArray(entry.connections)) invalid('Поле connections должно быть массивом.');
  const connections = entry.connections.map((value) => connection(value, paths, storageInput));
  const groups = new Map<string, ManagedConnection[]>();
  for (const item of connections) {
    const key = connectionKey(item.path, paths);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const sharedKey = connectionKey(getSkillDirectory(paths, name), paths);
  if (
    connections.some((item) => !desiredAgents.includes(item.agent)) ||
    new Set(connections.map((item) => item.agent)).size !== connections.length ||
    [...groups].some(
      ([key, group]) =>
        group.length > 1 &&
        (key !== sharedKey || group.some((item) => !isDirectAgent(item.agent, paths.scope))),
    )
  )
    invalid(
      'Управляемые подключения должны иметь уникальные пары агент/путь и относиться к указанным агентам.',
    );
  const archiveHash = Object.hasOwn(entry, 'archiveHash')
    ? digest(entry.archiveHash, 'archiveHash')
    : undefined;
  if (identity.kind === 'directory' && archiveHash !== undefined)
    invalid('Источник из папки не может содержать хеш архива.');
  if (identity.kind !== 'directory' && archiveHash === undefined)
    invalid('Записи архива и реестра должны содержать хеш архива.');
  return {
    name,
    source: identity,
    version,
    policy: policy as InstallationRecord['policy'],
    contentHash: digest(entry.contentHash, 'contentHash'),
    ...(archiveHash === undefined ? {} : { archiveHash }),
    agents: desiredAgents.sort(),
    connections: connections.sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0)),
  };
}

/**
 * Проверяет версию и весь lock, упорядочивает записи и запрещает общий управляемый путь у разных скиллов.
 *
 * @param storageInput - true для сериализации runtime-путей, false для строгого чтения сохранённых
 * данных.
 */
function normalize(value: unknown, paths: StatePaths, storageInput: boolean): LockFile {
  try {
    const lock = object(value, 'lock');
    if (Object.hasOwn(lock, 'version') && lock.version !== LOCK_VERSION) {
      if (typeof lock.version === 'number' && Number.isInteger(lock.version))
        throw new StateError(
          'UNSUPPORTED_LOCK_VERSION',
          `Неподдерживаемая версия файла состояния: ${lock.version}.`,
        );
      invalid('Версия файла состояния должна быть целым числом.');
    }
    keys(lock, ['version', 'skills']);
    const skills = object(lock.skills, 'skills');
    assertPortableNames(Object.keys(skills));
    const records = Object.fromEntries(
      Object.keys(skills)
        .sort()
        .map((name) => [name, record(skills[name], name, paths, storageInput)]),
    );
    const managedPaths = new Map<string, string>();
    for (const entry of Object.values(records)) {
      for (const connection of entry.connections) {
        const key = connectionKey(connection.path, paths);
        if (managedPaths.has(key) && managedPaths.get(key) !== entry.name)
          invalid('Разные скиллы не могут управлять одним путём подключения.');
        managedPaths.set(key, entry.name);
      }
    }
    return {
      version: LOCK_VERSION,
      skills: records,
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
