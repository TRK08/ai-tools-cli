/** Permanent identity only: signed download URLs never belong here. */
export type SourceIdentity =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'archive'; readonly path: string }
  | { readonly kind: 'registry'; readonly registryUrl: string; readonly slug: string };

/** Source adapters prepare content without knowing about agents or their links. */
export interface PreparedSource {
  readonly directory: string;
  readonly name: string;
  readonly description: string;
  readonly identity: SourceIdentity;
  readonly version: string | null;
  readonly contentHash: string;
  readonly archiveHash?: string;
  readonly cleanup: () => Promise<void>;
}
