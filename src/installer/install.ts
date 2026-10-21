import { isCancellation } from '../cancellation.ts';
import type { RuntimeContext } from '../runtime.ts';
import { assertSourceCompatible, sourceIdentityKey } from '../state/identity.ts';
import { assertSkillName, resolveConnectionPath } from '../state/paths.ts';
import type { StateTransaction } from '../state/store.ts';
import { createEmptyLock, type InstallationRecord } from '../state/types.ts';
import type { SourceIdentity } from '../sources/types.ts';
import { directoryChain, FileTransaction, type InstallerFileSystem } from './filesystem.ts';
import type { InstallationInspection } from './inspection.ts';
import { applyInstallPlan } from './apply.ts';
import { AddSkipped, NoConnections, UpdateSkipped } from './control.ts';
import { InstallationEvents } from './events.ts';
import {
  createAddPreview,
  createInstallPlan,
  createUpdatePreview,
  findReusableInstallation,
  localUpdateReason,
  registryUpdateReason,
} from './plan.ts';
import {
  preparationOptions,
  prepareSelectedSource,
  resolveSelectedSource,
  reusableContent,
  selectSource,
} from './source.ts';
import type { AgentId } from '../agents/catalog.ts';
import type {
  InstallationChange,
  InstallerOptions,
  InstalledSnapshot,
  RegistrySelection,
  UpdatePreview,
} from './types.ts';

/** Координирует одну установку внутри уже захваченной StateTransaction. */
export class InstallOperation {
  private readonly paths;

  /** Связывает этапы одной установки с инспекцией и callback-политикой фасада; операцию не запускает. */
  constructor(
    private readonly context: RuntimeContext,
    private readonly options: InstallerOptions,
    private readonly fs: InstallerFileSystem,
    private readonly inspection: InstallationInspection,
  ) {
    this.paths = inspection.paths;
  }

  /** Прерывает подготовку add; после подтверждения применяется транзакционный алгоритм. */
  private assertAddActive(name: string): void {
    if (this.options.signal?.aborted)
      throw new AddSkipped({ name, status: 'skipped', reason: 'cancelled' });
  }

  /** Передаёт карточку интерфейсу; отказ/отмена выходят до изменения установки. */
  private async reviewAdd(
    name: string,
    version: string | null,
    description: string | null,
    identity: SourceIdentity,
    policy: InstallationRecord['policy'],
    requested: readonly AgentId[],
    previous?: InstallationRecord,
  ): Promise<void> {
    this.assertAddActive(name);
    if (!this.options.reviewAdd) return;
    const preview = createAddPreview(
      { name, version, description, identity },
      this.paths,
      policy,
      requested.map((agent) => ({
        agent,
        path: resolveConnectionPath(
          this.inspection.connection(name, agent, previous).path,
          this.paths,
        ),
      })),
    );
    const decision = await this.options.reviewAdd(preview);
    if (decision !== 'approve')
      throw new AddSkipped({
        name,
        status: 'skipped',
        reason: decision === 'cancel' ? 'cancelled' : 'declined',
      });
    this.assertAddActive(name);
  }

  /** Публикует preview обновления; pinned/unchanged не прерывают пакет при отказе callback. */
  async reviewUpdate(
    record: InstallationRecord,
    latestVersion: string | null,
    reason: UpdatePreview['reason'],
  ): Promise<UpdatePreview> {
    const preview = createUpdatePreview(record, this.paths.scope, latestVersion, reason);
    const decision = (await this.options.reviewUpdate?.(preview)) ?? 'approve';
    if (decision !== 'approve' && preview.status === 'available')
      throw new UpdateSkipped({
        name: record.name,
        status: 'skipped',
        reason: decision === 'cancel' ? 'cancelled' : 'declined',
      });
    return preview;
  }

  /** Выполняет установку и завершает контекст событий после применения либо отката. */
  async run(
    input: string,
    force: boolean,
    requested: readonly AgentId[],
    state: StateTransaction,
    updating?: InstallationRecord,
    registrySelection?: RegistrySelection,
  ): Promise<InstallationChange> {
    const events = new InstallationEvents(
      this.options,
      updating ? 'update' : 'add',
      this.paths.scope,
      requested,
    );
    try {
      const result = await this.perform(
        input,
        force,
        requested,
        state,
        events,
        updating,
        registrySelection,
      );
      events.complete(result);
      return result;
    } catch (cause) {
      if (!updating && isCancellation(cause, this.options.signal))
        throw new AddSkipped({ name: input, status: 'skipped', reason: 'cancelled' });
      events.fail(cause);
      throw cause;
    }
  }

  /** Соблюдает порядок проверки, разрешения версии, подтверждения и подготовки снимка. */
  private async perform(
    input: string,
    force: boolean,
    requested: readonly AgentId[],
    state: StateTransaction,
    events: InstallationEvents,
    updating?: InstallationRecord,
    registrySelection?: RegistrySelection,
  ): Promise<InstallationChange> {
    if (!updating) this.assertAddActive(input);
    const lock = (await state.read()) ?? createEmptyLock();
    let selection = await selectSource(
      input,
      this.context,
      this.paths,
      this.options,
      updating,
      registrySelection,
    );
    events.select(selection);
    if (selection.registry)
      assertSourceCompatible(
        lock,
        selection.registry.reference.slug,
        selection.identity,
        this.paths,
      );
    const previousSource = Object.values(lock.skills).find(
      (record) =>
        sourceIdentityKey(record.source, this.paths) ===
        sourceIdentityKey(selection.identity, this.paths),
    );
    if (previousSource) events.includeAgents(previousSource.agents);
    await this.inspection.checkParents();
    let initialSnapshot: InstalledSnapshot | undefined;
    if (previousSource) {
      this.inspection.assertSupported(previousSource);
      initialSnapshot = await this.inspection.snapshot(
        previousSource.name,
        previousSource,
        force,
        requested,
        updating ? undefined : this.options.signal,
      );
    }
    try {
      selection = await resolveSelectedSource(
        selection,
        updating ? undefined : this.options.signal,
      );
    } catch (cause) {
      if (!updating) this.assertAddActive(selection.registry?.reference.slug ?? input);
      throw cause;
    }
    const { artifact, identity, policy } = selection;
    if (artifact) {
      events.resolve(artifact.version);
      if (initialSnapshot)
        await this.inspection.assertUnchanged(
          artifact.slug,
          initialSnapshot,
          force,
          updating ? undefined : this.options.signal,
        );
      else
        initialSnapshot = await this.inspection.snapshot(
          artifact.slug,
          previousSource,
          force,
          requested,
          updating ? undefined : this.options.signal,
        );
    }
    const installedHash = initialSnapshot?.contentHash ?? null;
    if (!updating && artifact)
      await this.reviewAdd(
        artifact.slug,
        artifact.version,
        null,
        identity,
        policy,
        requested,
        previousSource,
      );
    const reusable = findReusableInstallation(previousSource, artifact, installedHash);
    if (updating && artifact && this.options.reviewUpdate) {
      await this.reviewUpdate(
        updating,
        artifact.version,
        registryUpdateReason(
          updating,
          artifact,
          initialSnapshot!.copies.some((copy) => copy.contentHash !== updating.contentHash)
            ? null
            : installedHash,
          initialSnapshot!.connectionsNeedRepair,
        ),
      );
    }
    if (reusable) {
      const snapshot = initialSnapshot!;
      const plan = createInstallPlan(
        reusableContent(reusable, this.paths),
        snapshot,
        identity,
        policy,
        force,
      );
      if (plan.kind !== 'apply') return applyInstallPlan(plan, lock, state, this.inspection);
    }
    await directoryChain(
      this.paths.scope === 'project' ? this.paths.cwd : this.paths.home,
      ['.agents'],
      this.fs,
      true,
    );
    try {
      return await FileTransaction.run(this.paths.agentsDirectory, this.fs, async (files) => {
        const prepared = reusable
          ? reusableContent(reusable, this.paths)
          : await prepareSelectedSource(
              selection,
              preparationOptions(
                this.context,
                this.paths,
                files.workspace,
                !updating && !artifact ? this.options.signal : undefined,
                Object.values(lock.skills),
              ),
              this.options.prepare,
              (download) => events.download(download),
            );
        const name = prepared.name;
        assertSkillName(name);
        if (
          (previousSource && previousSource.name !== name) ||
          (updating && updating.name !== name)
        )
          throw new Error('Имя скилла в источнике изменилось; сначала удалите прежнюю установку.');
        if (
          updating &&
          sourceIdentityKey(prepared.identity, this.paths) !==
            sourceIdentityKey(updating.source, this.paths)
        )
          throw new Error('Тип источника изменился; сначала удалите прежнюю установку.');
        assertSourceCompatible(lock, name, prepared.identity, this.paths);
        const previous = Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
        if (previous) this.inspection.assertSupported(previous);
        const snapshot = artifact
          ? initialSnapshot!
          : await this.inspection.snapshot(
              name,
              previous,
              force,
              requested,
              updating ? undefined : this.options.signal,
            );
        if (!updating && !artifact)
          await this.reviewAdd(
            name,
            prepared.version,
            prepared.description,
            prepared.identity,
            policy,
            requested,
            previous,
          );
        if (snapshot.candidates.length && updating && !artifact && this.options.reviewUpdate)
          await this.reviewUpdate(
            updating,
            prepared.version,
            localUpdateReason(updating, prepared, snapshot),
          );
        const plan = createInstallPlan(prepared, snapshot, identity, policy, force);
        return applyInstallPlan(plan, lock, state, this.inspection, files, this.options.report);
      });
    } catch (cause) {
      if (cause instanceof NoConnections) return cause.result;
      throw cause;
    }
  }
}
