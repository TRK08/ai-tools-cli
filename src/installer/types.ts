import type { StateStore } from '../state/store.ts';
import type { InstallationRecord, ManagedConnection } from '../state/types.ts';
import type { SourceIdentity } from '../sources/types.ts';
import type { prepareLocalSource } from '../sources/local.ts';
import type {
  RegistryClient,
  RegistryArtifact,
  RegistryClientOptions,
  RegistryDownload,
} from '../registry/client.ts';
import type { RegistryReference } from '../registry/reference.ts';
import type { Telemetry } from '../telemetry/client.ts';
import type { InstallerFileSystem } from './filesystem.ts';
import type { AgentId } from '../agents/catalog.ts';
import type { InstallationScope } from '../runtime.ts';

export interface InstallerOptions {
  readonly scope?: InstallationScope;
  readonly fileSystem?: InstallerFileSystem;
  readonly store?: StateStore;
  readonly prepare?: typeof prepareLocalSource;
  readonly report?: (message: string) => void;
  readonly registry?: string;
  readonly registryClientOptions?: RegistryClientOptions;
  readonly onDownload?: (download: RegistryDownload) => void;
  readonly telemetry?: Telemetry;
  readonly reviewUpdate?: (preview: UpdatePreview) => Promise<UpdateDecision>;
  readonly reviewAdd?: (preview: AddPreview) => Promise<AddDecision>;
  /** Отменяет подготовку и метаданные до подтверждения add; затем установка транзакционная. */
  readonly signal?: AbortSignal;
}

export type AddDecision = 'approve' | 'decline' | 'cancel';

/** Фиксирует подтверждённую версию отдельно от политики последующих обновлений. */
export interface RegistrySelection extends RegistryReference {
  readonly policy?: 'latest' | 'exact';
}

export interface AddPreview {
  readonly name: string;
  readonly version: string | null;
  readonly description: string | null;
  readonly source: SourceIdentity;
  readonly scope: InstallationScope;
  readonly policy: InstallationRecord['policy'];
  readonly sharedDirectory: string;
  readonly destinations: readonly { readonly agent: AgentId; readonly path: string }[];
}

export interface SkippedAdd {
  readonly name: string;
  readonly status: 'skipped';
  readonly reason: 'declined' | 'cancelled';
  readonly download?: never;
  readonly changes?: never;
}

export type AddResult = InstallationChange | SkippedAdd;

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

export type InstallationChange = {
  readonly name: string;
  readonly download?: RegistryDownload;
  /** Разделяет реальные изменения установки и изменения только lock для телеметрии. */
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
  | InstallationChange
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

/** Выбранный источник; артефакт фиксирует фактическую версию, URL живёт только в памяти. */
export interface SourceSelection {
  readonly input: string;
  readonly identity: SourceIdentity;
  readonly policy: InstallationRecord['policy'];
  readonly registry: {
    readonly reference: RegistryReference;
    readonly client: RegistryClient;
  } | null;
  readonly artifact: RegistryArtifact | null;
}

/** Проверенный физический каталог; один contentHash записи служит эталоном всех копий. */
export interface InstalledCopy {
  readonly path: string;
  readonly owned: boolean;
  readonly exists: boolean;
  readonly contentHash: string | null;
}

/** Проверенное состояние всех копий и назначений до подтверждения и применения. */
export interface InstalledSnapshot {
  readonly previous: InstallationRecord | undefined;
  readonly contentHash: string | null;
  readonly copies: readonly InstalledCopy[];
  readonly destinations: readonly {
    readonly connection: ManagedConnection;
    readonly exists: boolean;
  }[];
  readonly candidates: readonly ManagedConnection[];
  readonly errors: readonly string[];
  readonly connectionsNeedRepair: boolean;
}

/** Данные снимка; reuse заимствует установленную копию и не передаёт владение ею. */
export interface InstallationContent {
  readonly ownership: 'prepared' | 'reuse';
  readonly directory: string;
  readonly name: string;
  readonly description: string | null;
  readonly identity: SourceIdentity;
  readonly version: string | null;
  readonly contentHash: string;
  readonly archiveHash?: string;
  readonly download?: RegistryDownload;
}

/** Намерение установки без I/O-зависимостей; итоговые изменения определяет исполнитель. */
export interface InstallPlan {
  readonly kind: 'unchanged' | 'metadata-only' | 'apply';
  readonly content: InstallationContent;
  readonly snapshot: InstalledSnapshot;
  readonly identity: SourceIdentity;
  readonly policy: InstallationRecord['policy'];
  readonly force: boolean;
}
