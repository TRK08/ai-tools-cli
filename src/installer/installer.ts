import { errorMessage } from '../errors.ts';
import type { RuntimeContext } from '../runtime.ts';
import { hasErrorCode } from '../state/errors.ts';
import { assertScopeLocation } from '../state/filesystem.ts';
import { assertSkillName, getStatePaths, resolveSourcePath } from '../state/paths.ts';
import { StateStore } from '../state/store.ts';
import type { InstallationRecord } from '../state/types.ts';
import { parseAgents } from '../agents/resolve.ts';
import { applyRemoval } from './apply.ts';
import { AddSkipped, UpdateSkipped } from './control.ts';
import { inspectPath, installerFileSystem } from './filesystem.ts';
import { InstallOperation } from './install.ts';
import { InstallationInspection } from './inspection.ts';
import type {
  AddResult,
  InstallationChange,
  InstallerOptions,
  RegistrySelection,
  UpdateBatch,
  UpdateChange,
} from './types.ts';
import type { AgentId } from '../agents/catalog.ts';

/** Фасад жизненного цикла скиллов с одной общей копией и независимыми подключениями. */
export class Installer {
  private readonly paths;
  private readonly fs;
  private readonly store;
  private readonly inspection;
  private readonly operation;

  /**
   * Вычисляет пути области и создаёт службы установки без чтения или изменения файлов.
   *
   * @throws StateError — небезопасные корни или проектная область в home.
   */
  constructor(context: RuntimeContext, options: InstallerOptions = {}) {
    this.paths = getStatePaths(context.roots, options.scope ?? 'project');
    this.fs = options.fileSystem ?? installerFileSystem;
    this.store = options.store ?? new StateStore(this.paths);
    this.inspection = new InstallationInspection(context, this.paths, this.fs);
    this.operation = new InstallOperation(context, options, this.fs, this.inspection);
  }

  /**
   * Устанавливает локальный источник или registry slug под блокировкой области.
   *
   * @param force - Разрешить замену правок управляемой копии; чужие назначения и смена источника
   * запрещены.
   * @returns Результат установки либо skipped после отказа/отмены и завершения очистки.
   */
  async add(
    source: string,
    force = false,
    agents: readonly AgentId[] = ['codex'],
  ): Promise<AddResult> {
    return this.addSource(source, force, agents);
  }

  /**
   * Устанавливает явно выбранную registry-версию, даже если локальный путь совпадает со slug. Политика
   * последующих обновлений задаётся отдельно от выбранной версии: find передаёт latest.
   */
  async addRegistry(
    reference: RegistrySelection,
    force = false,
    agents: readonly AgentId[] = ['codex'],
  ): Promise<AddResult> {
    return this.addSource(reference.slug, force, agents, reference);
  }

  /** Проверяет запрос и удерживает блокировку до завершения отмены, отката и очистки. */
  private async addSource(
    source: string,
    force: boolean,
    agents: readonly AgentId[],
    reference?: RegistrySelection,
  ): Promise<AddResult> {
    const requested = parseAgents(agents);
    if (!requested.length) throw new Error('Нужно указать хотя бы одного агента.');
    await assertScopeLocation(this.paths);
    const hadAgentsDirectory = await inspectPath(this.paths.agentsDirectory, this.fs);
    try {
      return await this.store.transaction((state) =>
        this.operation.run(source, force, requested, state, undefined, reference),
      );
    } catch (cause) {
      if (!(cause instanceof AddSkipped)) throw cause;
      if (!hadAgentsDirectory) {
        // Удаляем созданный операцией родитель только пока он пуст.
        await this.fs.rmdir(this.paths.agentsDirectory).catch((error: unknown) => {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].some((code) => hasErrorCode(error, code)))
            throw error;
        });
      }
      return cause.result;
    }
  }

  /**
   * Последовательно обновляет записи под одной блокировкой; ошибки отдельных записей не останавливают
   * пакет.
   *
   * @remarks Фильтр агентов выбирает записи, затем обновляется общая копия для всех их агентов. Exact
   * пропускается; отказ пропускает запись, отмена завершает пакет с сохранением уже применённых
   * результатов.
   */
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
        throw new Error(`Скилл ${name} не установлен в этой области.`);
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
          await this.operation.reviewUpdate(record, null, 'pinned');
          results.push({ name: record.name, status: 'pinned', version: record.version! });
          continue;
        }
        try {
          const source =
            record.source.kind === 'registry'
              ? record.source.slug
              : resolveSourcePath(record.source.path, this.paths);
          results.push(await this.operation.run(source, force, record.agents, state, record));
        } catch (cause) {
          if (cause instanceof UpdateSkipped) {
            results.push(cause.result);
            if (cause.result.reason === 'cancelled') break;
            continue;
          }
          results.push({
            name: record.name,
            status: 'failed',
            errors: [errorMessage(cause)],
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

  /** Читает собственный lock без сети и создания каталогов; фильтр сохраняет всех агентов записи. */
  async list(agents: readonly AgentId[] = []): Promise<readonly InstallationRecord[]> {
    const selected = parseAgents(agents);
    const lock = await this.store.read();
    return Object.values(lock?.skills ?? {})
      .filter(
        (record) => !selected.length || record.agents.some((agent) => selected.includes(agent)),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Снимает выбранные управляемые подключения; последнюю копию удаляет вместе с ручными правками.
   *
   * @returns unchanged, если имя/подключения отсутствуют; partial/failed при ошибках отдельных
   * назначений.
   * @remarks Использует текущую запись под блокировкой; подтверждением выбранного списка управляет CLI.
   */
  async remove(name: string, agents: readonly AgentId[] = []): Promise<InstallationChange> {
    assertSkillName(name);
    const selected = parseAgents(agents);
    return this.store.transaction(async (state) => {
      const lock = await state.read();
      const record = lock && Object.hasOwn(lock.skills, name) ? lock.skills[name] : undefined;
      if (!record || !lock) return { status: 'unchanged', name };
      this.inspection.assertSupported(record);
      const requested = record.agents.filter(
        (agent) => !selected.length || selected.includes(agent),
      );
      if (!requested.length) return { status: 'unchanged', name };
      return applyRemoval(record, lock, requested, state, this.inspection, this.fs);
    });
  }
}
