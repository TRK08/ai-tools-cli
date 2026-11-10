import { isCancellation } from '@/cancellation';
import type { AgentId } from '@/agents';
import { errorMessage } from '@/errors';
import { RegistryClient, type PackageRelease } from '@/registry';
import type { InstallationScope, RuntimeContext } from '@/runtime';
import {
  createEmptyLock,
  getStatePaths,
  StateStore,
  type InstalledPackage,
  type LockFile,
  type StateTransaction,
} from '@/state';
import type { StateFileIO } from '@/state/store';
import type { Telemetry } from '@/telemetry';
import { applyPackage, preparePackage } from './apply';
import { FileTransaction, installerFileSystem, type InstallerFileSystem } from './filesystem';
import { InstallationInspection } from './inspection';
import { planInstall, planRemoval, skillPreview } from './plan';
import type {
  Decision,
  PackagePreview,
  PackageResult,
  SkillPlan,
  UpdateFailure,
  UpdateResult,
} from './types';

interface InstallerOptions {
  readonly scope: InstallationScope;
  readonly telemetry?: Telemetry;
  readonly fileSystem?: InstallerFileSystem;
  readonly stateIO?: StateFileIO;
}

type Review = (preview: PackagePreview) => Promise<Decision>;

interface PackagePlan {
  readonly preview: PackagePreview;
  readonly registryUrl: string;
  readonly skills: readonly SkillPlan[];
  readonly client?: RegistryClient;
}

interface UpdateSelection {
  readonly slug?: string;
  readonly skills: readonly string[];
  readonly agents: readonly AgentId[];
}

/** Проверяет фильтр имён и сохраняет порядок входного состава. Пустой фильтр выбирает весь состав. */
function selectNames<T extends { readonly name: string }>(
  available: readonly T[],
  names: readonly string[],
  slug: string,
): readonly T[] {
  for (const name of names) {
    if (!available.some((item) => item.name === name))
      throw new Error(`Скилл ${name} отсутствует в выбранном составе пакета ${slug}.`);
  }
  return names.length ? available.filter((item) => names.includes(item.name)) : available;
}

/** Управляет пакетами в одной области. Методы изменения держат блокировку до commit и очистки. */
export class Installer {
  private readonly store: StateStore;
  private readonly inspection: InstallationInspection;
  private readonly fs: InstallerFileSystem;

  /** Связывает область, подменяемые HTTP и файловые операции. Создание не выполняет I/O. */
  constructor(
    private readonly context: RuntimeContext,
    private readonly options: InstallerOptions,
  ) {
    const paths = getStatePaths(context.roots, options.scope);
    this.fs = options.fileSystem ?? installerFileSystem;
    this.store = new StateStore(paths, options.stateIO);
    this.inspection = new InstallationInspection(context, paths, this.fs);
  }

  /** Читает только lock выбранной области без запросов и создания каталогов. */
  async list(): Promise<readonly InstalledPackage[]> {
    return (await this.store.read())?.packages ?? [];
  }

  /** Добавляет выбранный состав и сохраняет остальные связи, переводя пакет на уже выбранный релиз. */
  async add(
    client: RegistryClient,
    release: PackageRelease,
    names: readonly string[],
    agents: readonly AgentId[],
    review: Review,
    signal = this.context.signal,
  ): Promise<PackageResult> {
    signal?.throwIfAborted();
    if (!agents.length) throw new Error('Укажите хотя бы одного агента.');
    const selected = selectNames(release.skills, names, release.slug);
    if (!selected.length)
      throw new Error(`В релизе ${release.slug}@${release.version} нет скиллов.`);
    return this.store.transaction(async (state) => {
      signal?.throwIfAborted();
      const lock = (await state.read()) ?? createEmptyLock();
      const before = lock.packages.find((entry) => entry.slug === release.slug);
      if (before && before.registryUrl !== client.registryUrl)
        throw new Error(
          `Пакет ${release.slug} установлен из другого реестра: ${before.registryUrl}.`,
        );
      const plan = await this.releasePlan(
        lock,
        before,
        client,
        release,
        selected.map((item) => item.name),
        agents,
        signal,
      );
      signal?.throwIfAborted();
      return this.reviewAndApply(lock, state, plan, review, signal);
    });
  }

  /** Снимает выбранные подключения пакета без сети. Превью построено под блокировкой по текущему lock. */
  async remove(
    slug: string,
    names: readonly string[],
    agents: readonly AgentId[],
    review: Review,
    signal = this.context.signal,
  ): Promise<PackageResult> {
    signal?.throwIfAborted();
    return this.store.transaction(async (state) => {
      signal?.throwIfAborted();
      const lock = (await state.read()) ?? createEmptyLock();
      const before = lock.packages.find((entry) => entry.slug === slug);
      if (!before) throw new Error(`Пакет ${slug} не установлен.`);
      const selected = selectNames(before.skills, names, slug);
      const skills: SkillPlan[] = [];
      for (const skill of selected) {
        const plan = await planRemoval(
          this.inspection,
          skill,
          agents.length ? agents : skill.connections.map((item) => item.agent),
          signal,
        );
        if (plan) skills.push(plan);
      }
      return this.reviewAndApply(
        lock,
        state,
        this.packagePlan(before.registryUrl, slug, before, skills, before.version),
        review,
        signal,
      );
    });
  }

  /**
   * Разрешает current по одному разу на пакет. Один review выбирает пакеты, ошибки планирования
   * и применения учитываются отдельно; уже записанные пакеты сохраняются.
   */
  async update(
    selection: UpdateSelection,
    review: (previews: readonly PackagePreview[]) => Promise<readonly string[] | null>,
    signal = this.context.signal,
  ): Promise<UpdateResult> {
    signal?.throwIfAborted();
    if (selection.skills.length && !selection.slug) throw new Error('Для --skill укажите пакет.');
    return this.store.transaction(async (state) => {
      signal?.throwIfAborted();
      let lock = (await state.read()) ?? createEmptyLock();
      const named = lock.packages.filter(
        (entry) => !selection.slug || entry.slug === selection.slug,
      );
      if (selection.slug && !named.length)
        throw new Error(`Пакет ${selection.slug} не установлен.`);
      if (selection.slug) selectNames(named[0]!.skills, selection.skills, selection.slug);
      const plans: PackagePlan[] = [];
      const failures: UpdateFailure[] = [];
      for (const before of named) {
        signal?.throwIfAborted();
        if (
          selection.agents.length &&
          !before.skills.some((skill) =>
            skill.connections.some((item) => selection.agents.includes(item.agent)),
          )
        )
          continue;
        try {
          const client = new RegistryClient(before.registryUrl, this.context.http);
          const release = await client.getPackage({ slug: before.slug }, signal);
          const plan = await this.releasePlan(lock, before, client, release, [], [], signal);
          if (plan.skills.length) plans.push(plan);
        } catch (cause) {
          if (isCancellation(cause, signal)) throw cause;
          failures.push({ slug: before.slug, error: errorMessage(cause) });
        }
      }
      const updated: string[] = [];
      if (!plans.length) return { updated, failures, cancelled: false };
      const chosen = await review(plans.map((plan) => plan.preview));
      if (chosen === null || signal?.aborted) return { updated, failures, cancelled: true };
      for (const plan of plans) {
        if (signal?.aborted) return { updated, failures, cancelled: true };
        if (!chosen.includes(plan.preview.slug)) continue;
        try {
          await this.commit(lock, state, plan, signal);
          updated.push(plan.preview.slug);
        } catch (cause) {
          if (isCancellation(cause, signal)) return { updated, failures, cancelled: true };
          failures.push({ slug: plan.preview.slug, error: errorMessage(cause) });
        }
        // При ошибке очистки commit мог уже состояться. Следующий пакет начинает с lock на диске.
        lock = (await state.read()) ?? createEmptyLock();
      }
      return { updated, failures, cancelled: signal?.aborted ?? false };
    });
  }

  /** Планирует объединение прежнего состава и явного выбора, отмечая исчезнувшие компоненты. */
  private async releasePlan(
    lock: LockFile,
    before: InstalledPackage | undefined,
    client: RegistryClient,
    release: PackageRelease,
    names: readonly string[],
    agents: readonly AgentId[],
    signal = this.context.signal,
  ): Promise<PackagePlan> {
    const changed = before?.version !== release.version;
    const existing = before?.skills ?? [];
    const skills: SkillPlan[] = [];
    for (const component of release.skills) {
      const saved = existing.find((item) => item.name === component.name);
      const selected = names.includes(component.name);
      if (!selected && !saved) continue;
      const occupied = lock.packages.some((entry) =>
        entry.skills.some(
          (item) =>
            item.installName === component.installName &&
            (entry.slug !== release.slug || item.name !== component.name),
        ),
      );
      if (occupied)
        throw new Error(`Каталог ${component.installName} уже управляется другим скиллом.`);
      const plan = await planInstall(
        this.inspection,
        component,
        saved,
        selected ? agents : [],
        changed,
        signal,
      );
      if (plan) skills.push(plan);
    }
    for (const skill of existing) {
      if (release.skills.some((item) => item.name === skill.name)) continue;
      if (!changed)
        throw new Error(`Состав пакета ${release.slug} изменился в пределах одного релиза.`);
      const removed = await planRemoval(
        this.inspection,
        skill,
        skill.connections.map((item) => item.agent),
        signal,
      );
      if (removed) skills.push(removed);
    }
    return this.packagePlan(
      client.registryUrl,
      release.slug,
      before,
      skills,
      release.version,
      client,
    );
  }

  /** Собирает сводку версии, выбранных скиллов, затронутых агентов и путей с правками. */
  private packagePlan(
    registryUrl: string,
    slug: string,
    before: InstalledPackage | undefined,
    skills: readonly SkillPlan[],
    version: string,
    client?: RegistryClient,
  ): PackagePlan {
    return {
      registryUrl,
      skills,
      ...(client && { client }),
      preview: {
        slug,
        ...(before && { previousVersion: before.version }),
        version,
        scope: this.inspection.paths.scope,
        skills: skills.map((plan) => skillPreview(plan, this.inspection)),
      },
    };
  }

  /** Возвращает отказ или отмену до загрузки ZIP, затем завершает атомарное применение. */
  private async reviewAndApply(
    lock: LockFile,
    state: StateTransaction,
    plan: PackagePlan,
    review: Review,
    signal = this.context.signal,
  ): Promise<PackageResult> {
    if (!plan.skills.length) return 'unchanged';
    const decision = await review(plan.preview);
    if (decision === 'cancel' || signal?.aborted) return 'cancelled';
    if (decision === 'decline') return 'declined';
    await this.commit(lock, state, plan, signal);
    return 'success';
  }

  /** Готовит все ZIP и копии, затем применяет файлы и lock в одной транзакции. */
  private async commit(
    lock: LockFile,
    state: StateTransaction,
    plan: PackagePlan,
    signal = this.context.signal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const { preview, registryUrl } = plan;
    const previous = lock.packages.find((item) => item.slug === preview.slug);
    const downloaded: string[] = [];
    const event = { registryUrl, slug: preview.slug, version: preview.version };
    await this.inspection.workspaceParent();
    await FileTransaction.run(this.inspection.paths.agentsDirectory, this.fs, async (files) => {
      let prepared;
      try {
        prepared = await preparePackage(
          plan.skills,
          files,
          this.inspection,
          plan.client,
          downloaded,
          this.context.roots,
          signal,
        );
      } finally {
        this.options.telemetry?.emit('download', { ...event, components: downloaded });
      }
      const skills = new Map(previous?.skills.map((item) => [item.name, item]));
      for (const item of prepared) {
        if (item.record) skills.set(item.record.name, item.record);
        else if (item.plan.kind === 'remove') skills.delete(item.plan.before.name);
      }
      const packages = lock.packages.filter((item) => item.slug !== preview.slug);
      if (skills.size) packages.push({ ...event, skills: [...skills.values()] });
      await applyPackage(prepared, files, this.inspection, signal);
      await state.write({ ...lock, packages }, signal);
      this.options.telemetry?.emit('install', {
        ...event,
        components: plan.skills.flatMap((item) =>
          item.kind === 'install' ? [item.component.name] : [],
        ),
      });
    });
  }
}
