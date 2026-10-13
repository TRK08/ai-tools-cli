import type { RegistryDownload } from '../registry/client.ts';

/** Постоянная идентичность источника; подписанные URL скачивания здесь не сохраняются. */
export type SourceIdentity =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'archive'; readonly path: string }
  | { readonly kind: 'registry'; readonly registryUrl: string; readonly slug: string };

/**
 * Адаптер готовит содержимое без знания об агентах и lock.
 *
 * @remarks Все временные ресурсы находятся внутри переданной temporaryDirectory. Прямой потребитель
 * вызывает cleanup; Installer передаёт владение базой FileTransaction.
 */
export interface PreparedSource {
  readonly directory: string;
  readonly name: string;
  readonly description: string;
  readonly identity: SourceIdentity;
  readonly version: string | null;
  readonly contentHash: string;
  readonly archiveHash?: string;
  /** Данные проверенной загрузки для телеметрии без подписанного URL. */
  readonly download?: RegistryDownload;
  /** Очищает только ресурсы адаптера; не применяется к заимствованной установленной копии. */
  readonly cleanup: () => Promise<void>;
}
