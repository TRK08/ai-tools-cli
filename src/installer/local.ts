import { dirname, join, relative, resolve } from 'node:path';
import type { RuntimeContext } from '../runtime.ts';
import { prepareDirectory } from '../sources/directory.ts';
import { assertScopeLocation } from '../state/filesystem.ts';
import { hashDirectory } from '../state/hash.ts';
import { assertSourceCompatible, sourceIdentityKey } from '../state/identity.ts';
import {
  assertSkillName,
  getSkillDirectory,
  getStatePaths,
  portableSourcePath,
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
  /** Synchronous presentation before replacement; business operations never write to stdout. */
  readonly report?: (message: string) => void;
}

export interface LocalChange {
  readonly status: 'success' | 'unchanged';
  readonly name: string;
}

/** Task 004 supports only project directory sources and explicitly selected Codex. */
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

  private connectionPath(name: string): string {
    return join(this.paths.cwd, '.agents', 'skills', name);
  }

  private assertSupported(record: InstallationRecord): void {
    if (
      record.source.kind !== 'directory' ||
      record.agents.length !== 1 ||
      record.agents[0] !== 'codex' ||
      record.connections.some(
        (connection) =>
          connection.agent !== 'codex' ||
          resolve(this.paths.cwd, connection.path) !== this.connectionPath(record.name),
      )
    ) {
      throw new Error('This stage supports only local directory installations for Codex.');
    }
  }

  private async checkParents(create = false): Promise<void> {
    await directoryChain(this.paths.cwd, ['.skills-installer', 'skills'], this.fs, create);
    await directoryChain(this.paths.cwd, ['.agents', 'skills'], this.fs, create);
  }

  private async checkConnection(name: string, record?: InstallationRecord): Promise<boolean> {
    const path = this.connectionPath(name);
    const stats = await inspectPath(path, this.fs);
    if (!stats) return false;
    const target = relative(dirname(path), getSkillDirectory(this.paths, name));
    if (
      !record?.connections.some((connection) => connection.agent === 'codex') ||
      !stats.isSymbolicLink() ||
      (await this.fs.readlink(path)) !== target
    ) {
      throw new Error(`Foreign Codex destination; remove or move it yourself: ${path}.`);
    }
    return true;
  }

  private async checkCopy(
    name: string,
    record: InstallationRecord | undefined,
    force: boolean,
  ): Promise<string | null> {
    const path = getSkillDirectory(this.paths, name);
    const stats = await inspectPath(path, this.fs);
    if (!stats) return null;
    if (!record || !stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Foreign shared-copy destination: ${path}.`);
    }
    let contentHash: string;
    try {
      contentHash = await hashDirectory(path);
    } catch (cause) {
      if (force) return null;
      throw new Error(`Cannot verify installed ${name}; use --force to replace its contents.`, {
        cause,
      });
    }
    if (!force && contentHash !== record.contentHash) {
      throw new Error(`Installed ${name} has local changes; use --force to replace its contents.`);
    }
    return contentHash;
  }

  private async workDirectories(): Promise<void> {
    await directoryChain(this.paths.cwd, ['.skills-installer', 'tmp'], this.fs, true);
    await directoryChain(this.paths.cwd, ['.skills-installer', 'backups'], this.fs, true);
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
      // Protect edits before potentially long source preparation, then check again before replacement.
      if (previousSource) {
        this.assertSupported(previousSource);
        await this.checkConnection(previousSource.name, previousSource);
        await this.checkCopy(previousSource.name, previousSource, force);
      }
      await this.workDirectories();
      const prepared = await this.prepare(source, {
        cwd: this.paths.cwd,
        temporaryDirectory: this.paths.temporaryDirectory,
        excludedDirectories: [join(this.paths.home, '.skills-installer')],
      });
      try {
        const name = prepared.name;
        assertSkillName(name);
        if (previousSource && previousSource.name !== name) {
          throw new Error('Source skill name changed; remove its previous installation first.');
        }
        assertSourceCompatible(lock, name, prepared.identity, this.paths);
        const previous = Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
        if (previous) this.assertSupported(previous);
        await this.checkParents();
        const connected = await this.checkConnection(name, previous);
        const currentHash = await this.checkCopy(name, previous, force);
        const destination = getSkillDirectory(this.paths, name);
        if (
          previous &&
          previous.contentHash === prepared.contentHash &&
          previous.version === prepared.version &&
          currentHash === prepared.contentHash &&
          connected
        ) {
          return { status: 'unchanged', name };
        }
        const replaceCopy = currentHash !== prepared.contentHash;
        if (replaceCopy && previous)
          this.options.report?.(`Replacing ${name}; affected agents: codex.`);
        await this.checkParents(true);
        return await FileTransaction.run(this.paths.backupDirectory, this.fs, async (files) => {
          // Revalidate immediately before mutations, including changes made during presentation/mkdir.
          await this.checkParents();
          const stillConnected = await this.checkConnection(name, previous);
          const finalHash = await this.checkCopy(name, previous, force);
          if (finalHash !== prepared.contentHash) {
            if (!replaceCopy && previous) {
              this.options.report?.(`Replacing ${name}; affected agents: codex.`);
            }
            if (await inspectPath(destination, this.fs)) {
              await files.move(destination, join(files.backup, 'skill'));
            }
            await files.move(prepared.directory, destination);
          }
          if (!stillConnected) {
            const path = this.connectionPath(name);
            await files.connect(relative(dirname(path), destination), path);
          }
          const record: InstallationRecord = {
            name,
            source: { kind: 'directory', path: portableSourcePath(identity.path, this.paths) },
            version: prepared.version,
            policy: 'local',
            contentHash: prepared.contentHash,
            agents: ['codex'],
            connections: [
              { agent: 'codex', path: relative(this.paths.cwd, this.connectionPath(name)) },
            ],
          };
          await state.write({ ...lock, skills: { ...lock.skills, [name]: record } });
          return { status: 'success', name };
        });
      } finally {
        await prepared.cleanup();
      }
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
      await this.checkConnection(name, record);
      const destination = getSkillDirectory(this.paths, name);
      const copy = await inspectPath(destination, this.fs);
      if (copy && (!copy.isDirectory() || copy.isSymbolicLink())) {
        throw new Error(`Foreign shared-copy destination: ${destination}.`);
      }
      await this.workDirectories();
      return FileTransaction.run(this.paths.backupDirectory, this.fs, async (files) => {
        await this.checkParents();
        if (await this.checkConnection(name, record)) {
          await files.move(this.connectionPath(name), join(files.backup, 'connection'));
        }
        const currentCopy = await inspectPath(destination, this.fs);
        if (currentCopy && (!currentCopy.isDirectory() || currentCopy.isSymbolicLink())) {
          throw new Error(`Foreign shared-copy destination: ${destination}.`);
        }
        if (currentCopy) await files.move(destination, join(files.backup, 'skill'));
        const skills = { ...lock.skills };
        delete skills[name];
        await state.write({ ...lock, skills });
        return { status: 'success', name };
      });
    });
  }
}
