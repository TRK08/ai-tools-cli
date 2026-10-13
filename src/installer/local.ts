import { dirname, join, parse, relative, resolve } from 'node:path';
import type { RuntimeContext } from '../runtime.ts';
import {
  localSourceIdentity,
  prepareLocalSource,
  registryReferenceForSource,
} from '../sources/local.ts';
import {
  RegistryClient,
  type RegistryClientOptions,
  type RegistryDownload,
} from '../registry/client.ts';
import { getRegistryUrl } from '../registry/reference.ts';
import { prepareRegistrySource } from '../sources/registry.ts';
import { assertScopeLocation } from '../state/filesystem.ts';
import { hashDirectory } from '../state/hash.ts';
import { assertSourceCompatible, sourceIdentityKey } from '../state/identity.ts';
import {
  assertSkillName,
  getSkillDirectory,
  getStatePaths,
  LOCK_TEMP_PREFIX,
  portableConnectionPath,
  portableSourcePath,
  resolveConnectionPath,
  resolveSourcePath,
  WORKSPACE_PREFIX,
} from '../state/paths.ts';
import { StateStore, type StateTransaction } from '../state/store.ts';
import {
  createEmptyLock,
  type InstallationRecord,
  type ManagedConnection,
} from '../state/types.ts';
import { agentSkillsDirectory, parseAgents } from './agents.ts';
import {
  directoryChain,
  FileTransaction,
  inspectPath,
  installerFileSystem,
  type InstallerFileSystem,
} from './filesystem.ts';
import type { AgentId, InstallationScope } from './types.ts';

export interface LocalInstallerOptions {
  readonly scope?: InstallationScope;
  readonly fileSystem?: InstallerFileSystem;
  readonly store?: StateStore;
  readonly prepare?: typeof prepareLocalSource;
  readonly report?: (message: string) => void;
  readonly registry?: string;
  readonly registryClientOptions?: RegistryClientOptions;
  readonly onDownload?: (download: RegistryDownload) => void;
  readonly reviewUpdate?: (preview: UpdatePreview) => Promise<UpdateDecision>;
}

export type UpdateDecision = 'approve' | 'decline' | 'cancel';

export interface UpdatePreview {
  readonly name: string;
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly sourceKind: InstallationRecord['source']['kind'];
  readonly scope: InstallationScope;
  readonly agents: readonly AgentId[];
  readonly status: 'available' | 'unchanged' | 'pinned';
  readonly reason: 'version' | 'artifact' | 'source' | 'copy' | 'connections' | 'pinned' | null;
}

export interface SkippedUpdate {
  readonly name: string;
  readonly status: 'skipped';
  readonly reason: 'declined' | 'cancelled';
}

export type LocalChange = {
  readonly name: string;
  readonly download?: RegistryDownload;
  /** Separate installation work from lock-only changes for telemetry consumers. */
  readonly changes?: {
    readonly content: boolean;
    readonly connections: boolean;
    readonly metadata: boolean;
  };
} & (
  | { readonly status: 'success' | 'unchanged' }
  | { readonly status: 'partial' | 'failed'; readonly errors: readonly string[] }
);

export type UpdateChange =
  | LocalChange
  | SkippedUpdate
  | {
      readonly name: string;
      readonly status: 'pinned';
      readonly version: string;
    };

export interface UpdateBatch {
  readonly status: 'success' | 'failed';
  readonly results: readonly UpdateChange[];
}

class NoConnections extends Error {
  constructor(readonly result: LocalChange) {
    super('No requested connections succeeded.');
  }
}

class UpdateSkipped extends Error {
  constructor(readonly result: SkippedUpdate) {
    super('Update was not approved.');
  }
}

/** Shared source lifecycle with one copy and independently registered agent connections. */
export class LocalInstaller {
  private readonly paths;
  private readonly fs;
  private readonly store;
  private readonly prepare;

  constructor(
    private readonly context: RuntimeContext,
    private readonly options: LocalInstallerOptions = {},
  ) {
    this.paths = getStatePaths(context.roots, options.scope ?? 'project');
    this.fs = options.fileSystem ?? installerFileSystem;
    this.store = options.store ?? new StateStore(this.paths);
    this.prepare = options.prepare ?? prepareLocalSource;
  }

  private assertSupported(record: InstallationRecord): void {
    for (const connection of record.connections) {
      const path = resolveConnectionPath(connection.path, this.paths);
      const shared = getSkillDirectory(this.paths, record.name);
      const direct =
        this.paths.scope === 'project'
          ? ['codex', 'opencode', 'cursor'].includes(connection.agent)
          : connection.agent === 'codex';
      if (
        (direct && path !== shared) ||
        (!direct && path === shared) ||
        (this.paths.scope === 'project' &&
          path !==
            join(agentSkillsDirectory(this.context, 'project', connection.agent), record.name))
      )
        throw new Error(`Invalid managed connection for ${connection.agent}: ${path}.`);
    }
  }

  private async checkParents(create = false): Promise<void> {
    await directoryChain(
      this.paths.scope === 'project' ? this.paths.cwd : this.paths.home,
      ['.agents', 'skills'],
      this.fs,
      create,
    );
  }

  private async connectionParents(path: string, create = false): Promise<void> {
    // For env overrides outside home, inspect every parent before any mutation.
    const parent = dirname(path);
    const root = this.paths.scope === 'project' ? this.paths.cwd : parse(parent).root;
    await directoryChain(root, relative(root, parent).split('/').filter(Boolean), this.fs, create);
  }

  private async inspectCopy(name: string, record?: InstallationRecord): Promise<boolean> {
    const path = getSkillDirectory(this.paths, name);
    const stats = await inspectPath(path, this.fs);
    if (!stats) return false;
    if (!record || !stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Foreign shared-copy destination: ${path}.`);
    }
    return true;
  }

  private async checkCopy(
    name: string,
    record: InstallationRecord | undefined,
    force: boolean,
  ): Promise<string | null> {
    if (!(await this.inspectCopy(name, record))) return null;
    const path = getSkillDirectory(this.paths, name);
    let contentHash: string;
    try {
      contentHash = await hashDirectory(path);
    } catch (cause) {
      if (force) return null;
      throw new Error(`Cannot verify installed ${name}; use --force to replace its contents.`, {
        cause,
      });
    }
    if (!force && contentHash !== record!.contentHash) {
      throw new Error(`Installed ${name} has local changes; use --force to replace its contents.`);
    }
    return contentHash;
  }

  private connection(
    name: string,
    agent: AgentId,
    previous?: InstallationRecord,
  ): ManagedConnection {
    const connection = previous?.connections.find((item) => item.agent === agent) ?? {
      agent,
      path: portableConnectionPath(
        join(agentSkillsDirectory(this.context, this.paths.scope, agent), name),
        this.paths,
      ),
    };
    const path = resolveConnectionPath(connection.path, this.paths);
    const directAgent =
      this.paths.scope === 'project'
        ? ['codex', 'opencode', 'cursor'].includes(agent)
        : agent === 'codex';
    const withinShared = relative(this.paths.skillsDirectory, path);
    if (!directAgent && !withinShared.startsWith('../') && withinShared !== '..') {
      throw new Error(`Agent destination overlaps shared skill storage: ${path}.`);
    }
    return connection;
  }

  private async inspectConnection(
    connection: ManagedConnection,
    name: string,
    owned: boolean,
  ): Promise<boolean> {
    const path = resolveConnectionPath(connection.path, this.paths);
    await this.connectionParents(path);
    const stats = await inspectPath(path, this.fs);
    if (!stats) return false;
    const shared = getSkillDirectory(this.paths, name);
    if (path === shared) {
      if (!owned || !stats.isDirectory() || stats.isSymbolicLink())
        throw new Error(`Foreign shared-copy destination: ${path}.`);
    } else if (
      !owned ||
      !stats.isSymbolicLink() ||
      resolve(dirname(path), await this.fs.readlink(path)) !== shared
    ) {
      throw new Error(`Foreign agent destination: ${path}.`);
    }
    return true;
  }

  private async reviewUpdate(
    record: InstallationRecord,
    latestVersion: string | null,
    reason: UpdatePreview['reason'],
  ): Promise<UpdatePreview> {
    const preview: UpdatePreview = {
      name: record.name,
      currentVersion: record.version,
      latestVersion,
      sourceKind: record.source.kind,
      scope: this.paths.scope,
      agents: record.agents,
      status: reason === 'pinned' ? 'pinned' : reason === null ? 'unchanged' : 'available',
      reason,
    };
    const decision = (await this.options.reviewUpdate?.(preview)) ?? 'approve';
    if (decision !== 'approve' && preview.status === 'available')
      throw new UpdateSkipped({
        name: record.name,
        status: 'skipped',
        reason: decision === 'cancel' ? 'cancelled' : 'declined',
      });
    return preview;
  }

  private async connectionsNeedRepair(record: InstallationRecord): Promise<boolean> {
    for (const connection of record.connections) {
      try {
        if (!(await this.inspectConnection(connection, record.name, true))) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  async add(
    source: string,
    force = false,
    agents: readonly AgentId[] = ['codex'],
  ): Promise<LocalChange> {
    const requested = parseAgents(agents);
    if (!requested.length) throw new Error('At least one agent is required.');
    await assertScopeLocation(this.paths);
    return this.store.transaction((state) => this.install(source, force, requested, state));
  }

  private async install(
    source: string,
    force: boolean,
    requested: readonly AgentId[],
    state: StateTransaction,
    updating?: InstallationRecord,
  ): Promise<LocalChange> {
    const lock = (await state.read()) ?? createEmptyLock();
    const reference = updating
      ? updating.source.kind === 'registry'
        ? { slug: updating.source.slug }
        : null
      : await registryReferenceForSource(source, this.paths.cwd);
    const client =
      reference === null
        ? null
        : new RegistryClient(
            updating?.source.kind === 'registry'
              ? updating.source.registryUrl
              : getRegistryUrl(this.options.registry, this.context.env),
            this.context.http,
            this.options.registryClientOptions,
          );
    const identity =
      reference && client
        ? { kind: 'registry' as const, registryUrl: client.registryUrl, slug: reference.slug }
        : await localSourceIdentity(source, this.paths.cwd);
    const policy =
      updating?.policy ??
      (reference === null ? 'local' : reference.version === undefined ? 'latest' : 'exact');
    if (reference) assertSourceCompatible(lock, reference.slug, identity, this.paths);
    const previousSource = Object.values(lock.skills).find(
      (record) =>
        sourceIdentityKey(record.source, this.paths) === sourceIdentityKey(identity, this.paths),
    );
    await this.checkParents();
    let installedHash: string | null = null;
    if (previousSource) {
      this.assertSupported(previousSource);
      installedHash = await this.checkCopy(previousSource.name, previousSource, force);
    }
    const artifact = reference && client ? await client.resolveArtifact(reference) : null;
    const reusable =
      artifact &&
      previousSource &&
      previousSource.version === artifact.version &&
      previousSource.archiveHash === artifact.sha256 &&
      installedHash === previousSource.contentHash
        ? previousSource
        : null;
    let preview: UpdatePreview | undefined;
    if (updating && artifact && this.options.reviewUpdate) {
      const reason: UpdatePreview['reason'] =
        updating.version !== artifact.version
          ? 'version'
          : updating.archiveHash !== artifact.sha256
            ? 'artifact'
            : installedHash !== updating.contentHash
              ? 'copy'
              : (await this.connectionsNeedRepair(updating))
                ? 'connections'
                : null;
      preview = await this.reviewUpdate(updating, artifact.version, reason);
    }
    if (reusable) {
      // No workspace or download for an intact repeat; a policy change only writes the lock.
      let intact = true;
      for (const agent of requested) {
        const connection = reusable.connections.find((item) => item.agent === agent);
        try {
          if (!connection || !(await this.inspectConnection(connection, reusable.name, true)))
            intact = false;
        } catch {
          intact = false;
        }
      }
      if (!intact && preview?.status === 'unchanged')
        throw new Error(
          `Connections for ${reusable.name} changed during review; retry the operation.`,
        );
      if (intact) {
        if ((await this.checkCopy(reusable.name, reusable, force)) !== reusable.contentHash)
          throw new Error(
            `Installed ${reusable.name} changed during preparation; retry the operation.`,
          );
        const metadata = reusable.policy !== policy;
        if (metadata)
          await state.write({
            ...lock,
            skills: { ...lock.skills, [reusable.name]: { ...reusable, policy } },
          });
        return {
          name: reusable.name,
          status: metadata ? 'success' : 'unchanged',
          changes: { content: false, connections: false, metadata },
        };
      }
    }
    await directoryChain(
      this.paths.scope === 'project' ? this.paths.cwd : this.paths.home,
      ['.agents'],
      this.fs,
      true,
    );
    try {
      return await FileTransaction.run(
        this.paths.agentsDirectory,
        this.fs,
        async (files): Promise<LocalChange> => {
          const global = getStatePaths(this.context.roots, 'global');
          const preparationOptions = {
            cwd: this.paths.cwd,
            temporaryDirectory: files.workspace,
            excludedPaths: [global.skillsDirectory, global.lockPath, global.operationLockPath],
            excludedPrefixes: [
              join(global.agentsDirectory, WORKSPACE_PREFIX),
              join(global.root, LOCK_TEMP_PREFIX),
            ],
          };
          const prepared = reusable
            ? {
                ...reusable,
                identity: reusable.source,
                directory: getSkillDirectory(this.paths, reusable.name),
                download: undefined,
              }
            : reference && client
              ? await prepareRegistrySource(
                  reference,
                  client,
                  preparationOptions,
                  this.options.onDownload,
                  artifact!,
                )
              : await this.prepare(source, preparationOptions);
          const download = prepared.download === undefined ? {} : { download: prepared.download };
          const name = prepared.name;
          assertSkillName(name);
          if (
            (previousSource && previousSource.name !== name) ||
            (updating && updating.name !== name)
          )
            throw new Error('Source skill name changed; remove its previous installation first.');
          if (
            updating &&
            sourceIdentityKey(prepared.identity, this.paths) !==
              sourceIdentityKey(updating.source, this.paths)
          )
            throw new Error('Source kind changed; remove its previous installation first.');
          assertSourceCompatible(lock, name, prepared.identity, this.paths);
          const previous = Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
          if (previous) this.assertSupported(previous);
          await this.checkParents();
          const currentHash = await this.checkCopy(name, previous, force);
          const destination = getSkillDirectory(this.paths, name);
          const candidates: ManagedConnection[] = [];
          const errors: string[] = [];
          let connectionsNeedRepair = false;
          for (const agent of requested) {
            try {
              const connection = this.connection(name, agent, previous);
              const exists = await this.inspectConnection(
                connection,
                name,
                !!previous?.connections.some((item) => item.agent === agent) ||
                  (resolveConnectionPath(connection.path, this.paths) === destination &&
                    !!previous),
              );
              if (!exists) connectionsNeedRepair = true;
              candidates.push(connection);
            } catch (cause) {
              errors.push(`${agent}: ${cause instanceof Error ? cause.message : String(cause)}`);
            }
          }
          if (!candidates.length) return { status: 'failed', name, errors, ...download };
          if (updating && !artifact && this.options.reviewUpdate) {
            const reason: UpdatePreview['reason'] =
              currentHash !== updating.contentHash
                ? 'copy'
                : prepared.contentHash !== updating.contentHash
                  ? 'source'
                  : prepared.archiveHash !== updating.archiveHash
                    ? 'artifact'
                    : connectionsNeedRepair
                      ? 'connections'
                      : null;
            preview = await this.reviewUpdate(updating, prepared.version, reason);
          }
          let reported = false;
          const reportReplacement = () => {
            if (previous && !reported) {
              this.options.report?.(
                `Replacing ${name}; affected agents: ${[...new Set([...previous.agents, ...candidates.map((item) => item.agent)])].sort().join(', ')}.`,
              );
              reported = true;
            }
          };
          if (currentHash !== prepared.contentHash) reportReplacement();
          await this.checkParents(true);
          const finalHash = await this.checkCopy(name, previous, force);
          if (preview?.status === 'unchanged' && finalHash !== prepared.contentHash)
            throw new Error(`Installed ${name} changed during review; retry the operation.`);
          if (reusable && finalHash !== reusable.contentHash)
            throw new Error(`Installed ${name} changed during preparation; retry the operation.`);
          const replaced = finalHash !== prepared.contentHash;
          if (replaced) {
            reportReplacement();
            if (await this.inspectCopy(name, previous))
              await files.move(destination, join(files.workspace, 'previous'));
            await files.move(prepared.directory, destination);
          }
          const connections = new Map(previous?.connections.map((item) => [item.agent, item]));
          let successes = 0;
          let changed = replaced;
          let connectionsChanged = false;
          for (const connection of candidates) {
            try {
              const path = resolveConnectionPath(connection.path, this.paths);
              const direct = path === destination;
              const existed = await this.inspectConnection(
                connection,
                name,
                direct || connections.has(connection.agent),
              );
              if (!existed && preview?.status === 'unchanged')
                throw new Error(
                  `Connections for ${name} changed during review; retry the operation.`,
                );
              if (!existed) {
                if (direct) throw new Error(`Shared copy is missing: ${path}.`);
                await this.connectionParents(path, true);
                await files.link(
                  this.paths.scope === 'project'
                    ? relative(dirname(path), destination)
                    : destination,
                  path,
                );
                changed = true;
                connectionsChanged = true;
              }
              if (!connections.has(connection.agent)) {
                changed = true;
                connectionsChanged = true;
              }
              connections.set(connection.agent, connection);
              successes++;
            } catch (cause) {
              errors.push(
                `${connection.agent}: ${cause instanceof Error ? cause.message : String(cause)}`,
              );
            }
          }
          if (!successes) throw new NoConnections({ status: 'failed', name, errors, ...download });
          if (
            !changed &&
            !errors.length &&
            previous?.contentHash === prepared.contentHash &&
            previous.version === prepared.version &&
            previous.archiveHash === prepared.archiveHash &&
            previous.policy === policy
          )
            return {
              status: 'unchanged',
              name,
              ...download,
              changes: { content: false, connections: false, metadata: false },
            };
          const record: InstallationRecord = {
            name,
            source:
              identity.kind === 'registry'
                ? identity
                : { ...identity, path: portableSourcePath(identity.path, this.paths) },
            version: prepared.version,
            policy,
            contentHash: prepared.contentHash,
            ...(prepared.archiveHash === undefined ? {} : { archiveHash: prepared.archiveHash }),
            agents: [...new Set([...(previous?.agents ?? []), ...connections.keys()])],
            connections: [...connections.values()],
          };
          const metadata =
            previous?.contentHash !== record.contentHash ||
            previous.version !== record.version ||
            previous.archiveHash !== record.archiveHash ||
            previous.policy !== record.policy;
          if (changed || metadata) {
            await state.write({ ...lock, skills: { ...lock.skills, [name]: record } });
          }
          return errors.length
            ? {
                status: 'partial',
                name,
                errors,
                ...download,
                changes: { content: replaced, connections: connectionsChanged, metadata },
              }
            : {
                status: 'success',
                name,
                ...download,
                changes: { content: replaced, connections: connectionsChanged, metadata },
              };
        },
      );
    } catch (cause) {
      if (cause instanceof NoConnections) return cause.result;
      throw cause;
    }
  }

  async update(
    name?: string,
    force = false,
    agents: readonly AgentId[] = [],
  ): Promise<UpdateBatch> {
    if (name !== undefined) assertSkillName(name);
    const selected = parseAgents(agents);
    return this.store.transaction(async (state) => {
      const lock = await state.read();
      if (name !== undefined && (!lock || !Object.hasOwn(lock.skills, name)))
        throw new Error(`Skill ${name} is not installed in this scope.`);
      const records = Object.values(lock?.skills ?? {})
        .filter(
          (record) =>
            (name === undefined || record.name === name) &&
            (!selected.length || record.agents.some((agent) => selected.includes(agent))),
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      const results: UpdateChange[] = [];
      for (const record of records) {
        if (record.policy === 'exact') {
          await this.reviewUpdate(record, null, 'pinned');
          results.push({ name: record.name, status: 'pinned', version: record.version! });
          continue;
        }
        try {
          const source =
            record.source.kind === 'registry'
              ? record.source.slug
              : resolveSourcePath(record.source.path, this.paths);
          results.push(await this.install(source, force, record.agents, state, record));
        } catch (cause) {
          if (cause instanceof UpdateSkipped) {
            results.push(cause.result);
            if (cause.result.reason === 'cancelled') break;
            continue;
          }
          results.push({
            name: record.name,
            status: 'failed',
            errors: [cause instanceof Error ? cause.message : String(cause)],
          });
        }
      }
      return {
        status: results.some((result) => result.status === 'failed' || result.status === 'partial')
          ? 'failed'
          : 'success',
        results,
      };
    });
  }

  async list(agents: readonly AgentId[] = []): Promise<readonly InstallationRecord[]> {
    const selected = parseAgents(agents);
    const lock = await this.store.read();
    return Object.values(lock?.skills ?? {})
      .filter(
        (record) => !selected.length || record.agents.some((agent) => selected.includes(agent)),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove(name: string, agents: readonly AgentId[] = []): Promise<LocalChange> {
    assertSkillName(name);
    const selected = parseAgents(agents);
    return this.store.transaction(async (state) => {
      const lock = await state.read();
      const record = lock && Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
      if (!record || !lock) return { status: 'unchanged', name };
      this.assertSupported(record);
      const requested = record.agents.filter(
        (agent) => !selected.length || selected.includes(agent),
      );
      if (!requested.length) return { status: 'unchanged', name };
      await this.checkParents();
      await this.inspectCopy(name, record);
      await directoryChain(
        this.paths.scope === 'project' ? this.paths.cwd : this.paths.home,
        ['.agents'],
        this.fs,
        true,
      );
      return FileTransaction.run(
        this.paths.agentsDirectory,
        this.fs,
        async (files): Promise<LocalChange> => {
          const removed: AgentId[] = [];
          const errors: string[] = [];
          for (const agent of requested) {
            try {
              const connection = record.connections.find((item) => item.agent === agent);
              if (connection && (await this.inspectConnection(connection, name, true))) {
                const path = resolveConnectionPath(connection.path, this.paths);
                if (path !== getSkillDirectory(this.paths, name))
                  await files.move(path, join(files.workspace, `connection-${agent}`));
              }
              removed.push(agent);
            } catch (cause) {
              errors.push(`${agent}: ${cause instanceof Error ? cause.message : String(cause)}`);
            }
          }
          if (!removed.length) return { status: 'failed', name, errors };
          const remaining = record.agents.filter((agent) => !removed.includes(agent));
          const skills = { ...lock.skills };
          if (remaining.length)
            skills[name] = {
              ...record,
              agents: remaining,
              connections: record.connections.filter((item) => !removed.includes(item.agent)),
            };
          else {
            await this.checkParents();
            if (await this.inspectCopy(name, record))
              await files.move(
                getSkillDirectory(this.paths, name),
                join(files.workspace, 'previous'),
              );
            delete skills[name];
          }
          await state.write({ ...lock, skills });
          return errors.length ? { status: 'partial', name, errors } : { status: 'success', name };
        },
      );
    });
  }
}
