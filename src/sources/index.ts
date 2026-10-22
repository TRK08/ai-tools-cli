/** Подготовка снимков и идентичность источников; временной базой владеет вызывающая операция. */
export type { PrepareDirectoryOptions } from './directory';
export { OWNED_WORKSPACE_CLEANUP } from './filesystem';
export { localSourceIdentity, prepareLocalSource, registryReferenceForSource } from './local';
export { prepareRegistrySource } from './registry';
export type { SourceIdentity } from './types';
