/** Нативные операции и проверки имён без I/O; модуль не зависит от состояния установок. */
export { assertPortableName, assertPortableNames } from './names';
export {
  assertResourceNames,
  childBufferPath,
  hasBufferPathPrefix,
  isBufferPathWithin,
  isPathWithin,
  nativePath,
  pathIdentityKey,
  relativePathParts,
  samePath,
  validateNativePath,
} from './native-path';
