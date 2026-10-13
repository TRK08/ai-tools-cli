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
  WORKSPACE_PREFIX,
} from '../state/paths.ts';
import { StateStore } from '../state/store.ts';
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
}

export type LocalChange = {
  readonly name: string;
  readonly download?: RegistryDownload;
} & (
  | { readonly status: 'success' | 'unchanged' }
  | { readonly status: 'partial' | 'failed'; readonly errors: readonly string[] }
);

class NoConnections extends Error {
  constructor(readonly result: LocalChange) {
    super('No requested connections succeeded.');
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

  async add(
    source: string,
    force = false,
    agents: readonly AgentId[] = ['codex'],
  ): Promise<LocalChange> {
    const requested = parseAgents(agents);
    if (!requested.length) throw new Error('At least one agent is required.');
    await assertScopeLocation(this.paths);
    return this.store.transaction(async (state) => {
      const lock = (await state.read()) ?? createEmptyLock();
      const reference = await registryReferenceForSource(source, this.paths.cwd);
      const client =
        reference === null
          ? null
          : new RegistryClient(
              getRegistryUrl(this.options.registry, this.context.env),
              this.context.http,
              this.options.registryClientOptions,
            );
      const identity =
        reference && client
          ? { kind: 'registry' as const, registryUrl: client.registryUrl, slug: reference.slug }
          : await localSourceIdentity(source, this.paths.cwd);
      const policy =
        reference === null ? 'local' : reference.version === undefined ? 'latest' : 'exact';
      if (reference) assertSourceCompatible(lock, reference.slug, identity, this.paths);
      const previousSource = Object.values(lock.skills).find(
        (record) =>
          sourceIdentityKey(record.source, this.paths) === sourceIdentityKey(identity, this.paths),
      );
      await this.checkParents();
      if (previousSource) {
        this.assertSupported(previousSource);
        await this.checkCopy(previousSource.name, previousSource, force);
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
            const prepared =
              reference && client
                ? await prepareRegistrySource(
                    reference,
                    client,
                    preparationOptions,
                    this.options.onDownload,
                  )
                : await this.prepare(source, preparationOptions);
            const download = prepared.download === undefined ? {} : { download: prepared.download };
            const name = prepared.name;
            assertSkillName(name);
            if (previousSource && previousSource.name !== name)
              throw new Error('Source skill name changed; remove its previous installation first.');
            assertSourceCompatible(lock, name, prepared.identity, this.paths);
            const previous = Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
            if (previous) this.assertSupported(previous);
            await this.checkParents();
            const currentHash = await this.checkCopy(name, previous, force);
            const destination = getSkillDirectory(this.paths, name);
            const candidates: ManagedConnection[] = [];
            const errors: string[] = [];
            for (const agent of requested) {
              try {
                const connection = this.connection(name, agent, previous);
                await this.inspectConnection(
                  connection,
                  name,
                  !!previous?.connections.some((item) => item.agent === agent) ||
                    (resolveConnectionPath(connection.path, this.paths) === destination &&
                      !!previous),
                );
                candidates.push(connection);
              } catch (cause) {
                errors.push(`${agent}: ${cause instanceof Error ? cause.message : String(cause)}`);
              }
            }
            if (!candidates.length) return { status: 'failed', name, errors, ...download };
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
            for (const connection of candidates) {
              try {
                const path = resolveConnectionPath(connection.path, this.paths);
                const direct = path === destination;
                const existed = await this.inspectConnection(
                  connection,
                  name,
                  direct || connections.has(connection.agent),
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
                }
                if (!connections.has(connection.agent)) changed = true;
                connections.set(connection.agent, connection);
                successes++;
              } catch (cause) {
                errors.push(
                  `${connection.agent}: ${cause instanceof Error ? cause.message : String(cause)}`,
                );
              }
            }
            if (!successes)
              throw new NoConnections({ status: 'failed', name, errors, ...download });
            if (
              !changed &&
              !errors.length &&
              previous?.contentHash === prepared.contentHash &&
              previous.version === prepared.version &&
              previous.archiveHash === prepared.archiveHash &&
              previous.policy === policy
            )
              return { status: 'unchanged', name, ...download };
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
            if (
              changed ||
              previous?.contentHash !== record.contentHash ||
              previous.version !== record.version ||
              previous.archiveHash !== record.archiveHash ||
              previous.policy !== record.policy
            ) {
              await state.write({ ...lock, skills: { ...lock.skills, [name]: record } });
            }
            return errors.length
              ? { status: 'partial', name, errors, ...download }
              : { status: 'success', name, ...download };
          },
        );
      } catch (cause) {
        if (cause instanceof NoConnections) return cause.result;
        throw cause;
      }
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
