import type { RegistryDownload } from '../registry/client.ts';
import type { RegistryEventContext } from '../telemetry/client.ts';
import { AddSkipped, UpdateSkipped } from './control.ts';
import type { AgentId } from '../agents/catalog.ts';
import type { InstallationChange, InstallerOptions, SourceSelection } from './types.ts';
import type { InstallationScope } from '../runtime.ts';

/** Собирает контекст одной registry-операции; не вмешивается в файловую транзакцию. */
export class InstallationEvents {
  private event: RegistryEventContext | undefined;

  /** Создаёт контекст одной операции; registry и фактическая версия добавляются на следующих этапах. */
  constructor(
    private readonly options: InstallerOptions,
    private readonly operation: 'add' | 'update',
    private readonly scope: InstallationScope,
    private readonly requested: readonly AgentId[],
  ) {}

  /** Начинает контекст после выбора registry, до проверок совместимости и сети. */
  select(source: SourceSelection): void {
    if (!source.registry) return;
    const { reference, client } = source.registry;
    this.event = {
      registryUrl: client.registryUrl,
      slug: reference.slug,
      ...(reference.version === undefined ? {} : { version: reference.version }),
      operation: this.operation,
      scope: this.scope,
      agents: this.requested,
    };
  }

  /** Учитывает всех прежних агентов общей копии при повторной установке. */
  includeAgents(agents: readonly AgentId[]): void {
    if (this.event)
      this.event = { ...this.event, agents: [...new Set([...agents, ...this.requested])].sort() };
  }

  /** Обновляет контекст фактически разрешённой версией до скачивания. */
  resolve(version: string): void {
    if (this.event) this.event = { ...this.event, version };
  }

  /** Отмечает проверенную загрузку один раз, затем уведомляет существующего потребителя. */
  download(download: RegistryDownload): void {
    if (this.event)
      this.options.telemetry?.emit('download', { ...this.event, version: download.version });
    this.options.onDownload?.(download);
  }

  /** Отправляет install при реальной установке либо partial/failed; metadata-only не считается. */
  complete(result: InstallationChange): void {
    if (
      this.event &&
      (result.status === 'failed' ||
        result.status === 'partial' ||
        result.changes?.content ||
        result.changes?.connections)
    )
      this.options.telemetry?.emit(
        'install',
        this.event,
        result.status === 'partial' || result.status === 'failed' ? result.status : 'success',
      );
  }

  /** Отмечает ошибку операции; отказ и отмена диалога не создают событие. */
  fail(cause: unknown): void {
    if (this.event && !(cause instanceof AddSkipped) && !(cause instanceof UpdateSkipped))
      this.options.telemetry?.emit('install', this.event, 'failed');
  }
}
