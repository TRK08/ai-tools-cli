import path, { type PlatformPath } from 'node:path';
import { StateError } from './errors.ts';
import { assertWindowsName } from './names.ts';

/**
 * Создаёт операции путей с одной зависимостью node:path; в тестах подменяется только она.
 * По умолчанию используется API текущей ОС. Операции не выполняют I/O и не меняют исходные пути.
 */
export function createPathOperations(nativePath: PlatformPath = path) {
  const windows = nativePath.sep === '\\';

  /** Проверяет нативный путь; Windows не принимает UNC/device, drive-relative, корень без диска и ADS. */
  function validateNativePath(value: string): void {
    if (
      !value ||
      /\p{Cc}/u.test(value) ||
      (windows &&
        (/^[\\/]/u.test(value) ||
          /^[A-Za-z]:(?:$|[^\\/])/u.test(value) ||
          /[<>|?*"]/u.test(value) ||
          value.replace(/^[A-Za-z]:/u, '').includes(':')))
    ) {
      throw new StateError(
        'INVALID_PATH',
        'Недопустимый нативный путь: ' + JSON.stringify(value) + '.',
      );
    }
    if (windows) {
      for (const component of value
        .replace(/^[A-Za-z]:/u, '')
        .split(/[\\/]/u)
        .filter(Boolean)) {
        if (component !== '.' && component !== '..') assertWindowsName(component);
      }
    }
  }

  /** Нормализует абсолютный путь для сравнения, принимая локальный namespace-формат realpath. */
  function absoluteComparisonPath(value: string): string {
    const local = windows ? value.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/u, '') : value;
    validateNativePath(local);
    if (!nativePath.isAbsolute(local)) {
      throw new StateError('INVALID_PATH', 'Для сравнения требуется абсолютный путь.');
    }
    return nativePath.resolve(local);
  }

  /** Строит лексический ключ абсолютного пути; регистр Windows учитывается только в ключе, без realpath. */
  function pathIdentityKey(value: string): string {
    const normalized = absoluteComparisonPath(value);
    return windows ? normalized.toLowerCase() : normalized;
  }

  /** Сравнивает абсолютные пути по правилам ОС, не разыменовывая ссылки и не меняя строки для I/O. */
  function samePath(first: string, second: string): boolean {
    return pathIdentityKey(first) === pathIdentityKey(second);
  }

  /** Проверяет вложенность по компонентам; другой диск и выход через .. не входят в корень. */
  function isPathWithin(root: string, candidate: string): boolean {
    const delta = nativePath.relative(pathIdentityKey(root), pathIdentityKey(candidate));
    return !nativePath.isAbsolute(delta) && delta.split(nativePath.sep)[0] !== '..';
  }

  /** Возвращает нативные части для проверки родителей; выход за корень отклоняется до I/O. */
  function relativePathParts(root: string, candidate: string): string[] {
    if (!isPathWithin(root, candidate)) {
      throw new StateError('INVALID_PATH', 'Путь должен находиться внутри выбранного корня.');
    }
    return nativePath
      .relative(absoluteComparisonPath(root), absoluteComparisonPath(candidate))
      .split(nativePath.sep)
      .filter(Boolean);
  }

  return {
    nativePath,
    validateNativePath,
    pathIdentityKey,
    samePath,
    isPathWithin,
    relativePathParts,
  };
}

/** Операции текущей ОС: обычный node:path и проверки; бизнес-код не выбирает платформу. */
export const {
  nativePath,
  validateNativePath,
  pathIdentityKey,
  samePath,
  isPathWithin,
  relativePathParts,
} = createPathOperations();
