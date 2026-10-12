import { join, relative, resolve } from 'node:path';
import type { RuntimeContext } from '../runtime.ts';
import { prepareDirectory } from '../sources/directory.ts';
import { assertScopeLocation } from '../state/filesystem.ts';
import { hashDirectory } from '../state/hash.ts';
import { assertSourceCompatible, sourceIdentityKey } from '../state/identity.ts';
import {
  assertSkillName,
  getSkillDirectory,
  getStatePaths,
  LOCK_TEMP_PREFIX,
  portableSourcePath,
  WORKSPACE_PREFIX,
} from '../state/paths.ts';
import { StateStore } from '../state/store.ts';
import { createEmptyLock, type InstallationRecord } from '../state/types.ts';
import {
  directoryChain,
  FileTransaction,
  inspectPath,
  installerFileSystem,
  type InstallerFileSystem,
} from './filesystem.ts';

export interface LocalInstallerOptions {
  readonly fileSystem?: InstallerFileSystem;
  readonly store?: StateStore;
  readonly prepare?: typeof prepareDirectory;
  readonly report?: (message: string) => void;
}

export interface LocalChange {
  readonly status: 'success' | 'unchanged';
  readonly name: string;
}

/** Task 004 supports project directories and explicit Codex, which reads the shared copy directly. */
export class LocalInstaller {
  private readonly paths;
  private readonly fs;
  private readonly store;
  private readonly prepare;

  constructor(
    context: RuntimeContext,
    private readonly options: LocalInstallerOptions = {},
  ) {
    this.paths = getStatePaths(context.roots, 'project');
    this.fs = options.fileSystem ?? installerFileSystem;
    this.store = options.store ?? new StateStore(this.paths);
    this.prepare = options.prepare ?? prepareDirectory;
  }

  private assertSupported(record: InstallationRecord): void {
    if (
      record.source.kind !== 'directory' ||
      record.agents.length !== 1 ||
      record.agents[0] !== 'codex' ||
      record.connections.some(
        (connection) =>
          connection.agent !== 'codex' ||
          resolve(this.paths.cwd, connection.path) !== getSkillDirectory(this.paths, record.name),
      )
    ) {
      throw new Error('This stage supports only local directory installations for Codex.');
    }
  }

  private async checkParents(create = false): Promise<void> {
    await directoryChain(this.paths.cwd, ['.agents', 'skills'], this.fs, create);
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

  async add(source: string, force = false): Promise<LocalChange> {
    await assertScopeLocation(this.paths);
    return this.store.transaction(async (state) => {
      const lock = (await state.read()) ?? createEmptyLock();
      const identity = { kind: 'directory' as const, path: resolve(this.paths.cwd, source) };
      const previousSource = Object.values(lock.skills).find(
        (record) =>
          sourceIdentityKey(record.source, this.paths) === sourceIdentityKey(identity, this.paths),
      );
      await this.checkParents();
      if (previousSource) {
        this.assertSupported(previousSource);
        await this.checkCopy(previousSource.name, previousSource, force);
      }
      await directoryChain(this.paths.cwd, ['.agents'], this.fs, true);
      return FileTransaction.run(this.paths.agentsDirectory, this.fs, async (files) => {
        const global = getStatePaths({ cwd: this.paths.cwd, home: this.paths.home }, 'global');
        const prepared = await this.prepare(source, {
          cwd: this.paths.cwd,
          temporaryDirectory: files.workspace,
          excludedPaths: [global.skillsDirectory, global.lockPath, global.operationLockPath],
          excludedPrefixes: [
            join(global.agentsDirectory, WORKSPACE_PREFIX),
            join(global.root, LOCK_TEMP_PREFIX),
          ],
        });
        // The operation owns the temporary base and cleans it after commit or rollback.
        const name = prepared.name;
        assertSkillName(name);
        if (previousSource && previousSource.name !== name) {
          throw new Error('Source skill name changed; remove its previous installation first.');
        }
        assertSourceCompatible(lock, name, prepared.identity, this.paths);
        const previous = Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
        if (previous) this.assertSupported(previous);
        await this.checkParents();
        const currentHash = await this.checkCopy(name, previous, force);
        const destination = getSkillDirectory(this.paths, name);
        const connected = previous?.connections.some((connection) => connection.agent === 'codex');
        if (
          previous &&
          connected &&
          previous.contentHash === prepared.contentHash &&
          previous.version === prepared.version &&
          currentHash === prepared.contentHash
        ) {
          return { status: 'unchanged', name };
        }
        let reported = false;
        const reportReplacement = () => {
          if (previous && !reported) {
            this.options.report?.(`Replacing ${name}; affected agents: codex.`);
            reported = true;
          }
        };
        if (currentHash !== prepared.contentHash) reportReplacement();
        await this.checkParents(true);
        const finalHash = await this.checkCopy(name, previous, force);
        if (finalHash !== prepared.contentHash) {
          reportReplacement();
          if (await this.inspectCopy(name, previous)) {
            await files.move(destination, join(files.workspace, 'previous'));
          }
          await files.move(prepared.directory, destination);
        }
        const record: InstallationRecord = {
          name,
          source: { kind: 'directory', path: portableSourcePath(identity.path, this.paths) },
          version: prepared.version,
          policy: 'local',
          contentHash: prepared.contentHash,
          agents: ['codex'],
          connections: [{ agent: 'codex', path: relative(this.paths.cwd, destination) }],
        };
        await state.write({ ...lock, skills: { ...lock.skills, [name]: record } });
        return { status: 'success', name };
      });
    });
  }

  async list(): Promise<readonly InstallationRecord[]> {
    const lock = await this.store.read();
    return Object.values(lock?.skills ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove(name: string): Promise<LocalChange> {
    assertSkillName(name);
    return this.store.transaction(async (state) => {
      const lock = await state.read();
      const record = lock && Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
      if (!record || !lock) return { status: 'unchanged', name };
      this.assertSupported(record);
      await this.checkParents();
      await this.inspectCopy(name, record);
      await directoryChain(this.paths.cwd, ['.agents'], this.fs, true);
      return FileTransaction.run(this.paths.agentsDirectory, this.fs, async (files) => {
        await this.checkParents();
        if (await this.inspectCopy(name, record)) {
          await files.move(getSkillDirectory(this.paths, name), join(files.workspace, 'previous'));
        }
        const skills = { ...lock.skills };
        delete skills[name];
        await state.write({ ...lock, skills });
        return { status: 'success', name };
      });
    });
  }
}
