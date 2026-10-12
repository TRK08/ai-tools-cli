import { isAbsolute } from 'node:path';
import type { AgentId } from '../installer/types.ts';
import type { SourceIdentity } from '../sources/types.ts';
import { StateError } from './errors.ts';
import { normalizeRegistryUrl } from './identity.ts';
import {
  assertSkillName,
  portableConnectionPath,
  portableSourcePath,
  validatePathText,
  type StatePaths,
} from './paths.ts';
import {
  LOCK_VERSION,
  type InstallationRecord,
  type LockFile,
  type ManagedConnection,
} from './types.ts';

const agents: readonly AgentId[] = ['claude-code', 'codex', 'opencode', 'pi', 'cursor'];

function invalid(message: string): never {
  throw new StateError('INVALID_LOCK', message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    invalid(`Invalid fields; expected ${[...required, ...optional].join(', ')}.`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /\p{Cc}/u.test(value))
    invalid(`${label} must be a nonempty string without control characters.`);
  return value;
}

function digest(value: unknown, label: string): string {
  const hash = text(value, label);
  if (!/^[a-f\d]{64}$/i.test(hash)) invalid(`${label} must be a SHA-256 hex digest.`);
  return hash.toLowerCase();
}

function agent(value: unknown): AgentId {
  if (!agents.includes(value as AgentId)) invalid(`Unknown agent: ${JSON.stringify(value)}.`);
  return value as AgentId;
}

function source(value: unknown, paths: StatePaths, storageInput: boolean): SourceIdentity {
  const entry = object(value, 'source');
  if (entry.kind === 'registry') {
    keys(entry, ['kind', 'registryUrl', 'slug']);
    const slug = text(entry.slug, 'slug');
    assertSkillName(slug);
    return {
      kind: 'registry',
      registryUrl: normalizeRegistryUrl(text(entry.registryUrl, 'registryUrl')),
      slug,
    };
  }
  if (entry.kind !== 'directory' && entry.kind !== 'archive') invalid('Unsupported source kind.');
  keys(entry, ['kind', 'path']);
  const path = text(entry.path, 'source.path');
  validatePathText(path);
  if (!storageInput && isAbsolute(path) !== (paths.scope === 'global'))
    invalid(
      'Stored local source path must be relative for project scope and absolute for global scope.',
    );
  return { kind: entry.kind, path: portableSourcePath(path, paths) };
}

function connection(value: unknown, paths: StatePaths, storageInput: boolean): ManagedConnection {
  const entry = object(value, 'connection');
  keys(entry, ['agent', 'path']);
  const path = text(entry.path, 'connection.path');
  if (!storageInput && isAbsolute(path) !== (paths.scope === 'global'))
    invalid(
      'Stored connection path must be relative for project scope and absolute for global scope.',
    );
  return { agent: agent(entry.agent), path: portableConnectionPath(path, paths) };
}

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
  if (entry.name !== name) invalid('Skill map key and record name must match.');
  const identity = source(entry.source, paths, storageInput);
  const version = entry.version === null ? null : text(entry.version, 'version');
  const policy = entry.policy;
  if (identity.kind === 'registry') {
    if (!['latest', 'exact'].includes(policy as string) || version === null)
      invalid('Registry records require a version and latest/exact policy.');
  } else if (policy !== 'local') invalid('Local records require local policy.');
  if (!Array.isArray(entry.agents) || entry.agents.length === 0)
    invalid('At least one desired agent is required.');
  const desiredAgents = entry.agents.map(agent);
  if (new Set(desiredAgents).size !== desiredAgents.length)
    invalid('Duplicate agents are not allowed.');
  if (!Array.isArray(entry.connections)) invalid('connections must be an array.');
  const connections = entry.connections.map((value) => connection(value, paths, storageInput));
  if (
    connections.some((item) => !desiredAgents.includes(item.agent)) ||
    new Set(connections.map((item) => item.agent)).size !== connections.length ||
    new Set(connections.map((item) => item.path)).size !== connections.length
  )
    invalid('Managed connections must have unique agents/paths and belong to desired agents.');
  const archiveHash = Object.hasOwn(entry, 'archiveHash')
    ? digest(entry.archiveHash, 'archiveHash')
    : undefined;
  if (identity.kind === 'directory' && archiveHash !== undefined)
    invalid('Directory sources cannot have an archive hash.');
  if (identity.kind !== 'directory' && archiveHash === undefined)
    invalid('Archive and registry records require an archive hash.');
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

function normalize(value: unknown, paths: StatePaths, storageInput: boolean): LockFile {
  try {
    const lock = object(value, 'lock');
    if (Object.hasOwn(lock, 'version') && lock.version !== LOCK_VERSION) {
      if (typeof lock.version === 'number' && Number.isInteger(lock.version))
        throw new StateError(
          'UNSUPPORTED_LOCK_VERSION',
          `Unsupported lock version: ${lock.version}.`,
        );
      invalid('Lock version must be an integer.');
    }
    keys(lock, ['version', 'skills']);
    const skills = object(lock.skills, 'skills');
    const records = Object.fromEntries(
      Object.keys(skills)
        .sort()
        .map((name) => [name, record(skills[name], name, paths, storageInput)]),
    );
    const managedPaths = new Set<string>();
    for (const entry of Object.values(records)) {
      for (const connection of entry.connections) {
        if (managedPaths.has(connection.path))
          invalid('Different skills cannot manage the same connection path.');
        managedPaths.add(connection.path);
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

/** Parse persisted data strictly; a machine's absolute paths cannot enter a project lock. */
export function parseLockFile(value: unknown, paths: StatePaths): LockFile {
  return normalize(value, paths, false);
}

/** Accept runtime absolute paths, encode portable paths, validate, and write deterministic JSON. */
export function serializeLockFile(lock: LockFile, paths: StatePaths): string {
  return `${JSON.stringify(normalize(lock, paths, true), null, 2)}\n`;
}
