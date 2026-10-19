import path, { type PlatformPath } from 'node:path';
import { StateError } from './errors.ts';
import { assertPortableNames, assertWindowsName } from './names.ts';

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

  /** Проверяет имена до обхода; native POSIX сохраняет произвольные байты, Windows всегда строгий. */
  function assertResourceNames(names: readonly Buffer[], portableNames = true): void {
    if (portableNames) {
      assertPortableNames(names);
      return;
    }
    if (windows) {
      const seen = new Set<string>();
      for (const name of names) {
        const decoded = name.toString('utf8');
        if (!Buffer.from(decoded).equals(name))
          throw new StateError('INVALID_PATH', 'Windows-имя должно содержать корректный UTF-8.');
        assertWindowsName(decoded);
        const key = decoded.normalize('NFC').toLowerCase();
        if (seen.has(key)) throw new StateError('INVALID_PATH', 'Коллизия Windows-имён.');
        seen.add(key);
      }
      return;
    }
    for (const name of names) {
      if (
        !name.length ||
        name.includes(0) ||
        name.includes(47) ||
        name.equals(Buffer.from('.')) ||
        name.equals(Buffer.from('..'))
      ) {
        throw new StateError('INVALID_PATH', 'Некорректное байтовое имя объекта.');
      }
    }
  }

  /** Добавляет один проверенный компонент, сохраняя POSIX-байты и нативный разделитель. */
  function childBufferPath(parent: Buffer, name: Buffer): Buffer {
    assertResourceNames([name], false);
    const trailing = parent[parent.length - 1];
    const separator =
      trailing === 47 || (windows && trailing === 92)
        ? Buffer.alloc(0)
        : Buffer.from(nativePath.sep);
    return Buffer.concat([parent, separator, name]);
  }

  /** Нормализует путь только для сравнения: POSIX-компоненты без декодирования, Windows с namespace. */
  function comparisonBuffer(value: Buffer): Buffer {
    if (windows) {
      const decoded = value.toString('utf8');
      if (!Buffer.from(decoded).equals(value))
        throw new StateError('INVALID_PATH', 'Windows-путь должен содержать корректный UTF-8.');
      return Buffer.from(pathIdentityKey(decoded));
    }
    if (value[0] !== 47 || value.includes(0))
      throw new StateError('INVALID_PATH', 'Требуется абсолютный байтовый путь.');
    const parts: Buffer[] = [];
    let start = 1;
    for (let end = 1; end <= value.length; end++) {
      if (end !== value.length && value[end] !== 47) continue;
      const part = value.subarray(start, end);
      start = end + 1;
      if (!part.length || part.equals(Buffer.from('.'))) continue;
      if (part.equals(Buffer.from('..'))) parts.pop();
      else parts.push(part);
    }
    return Buffer.concat([
      Buffer.from('/'),
      ...parts.flatMap((part, index) => (index ? [Buffer.from('/'), part] : [part])),
    ]);
  }

  /** Проверяет вложенность байтовых путей по границам компонентов, без потерь UTF-8 на POSIX. */
  function isBufferPathWithin(root: Buffer, candidate: Buffer): boolean {
    const base = comparisonBuffer(root);
    const target = comparisonBuffer(candidate);
    const prefix =
      base[base.length - 1] === nativePath.sep.charCodeAt(0)
        ? base
        : Buffer.concat([base, Buffer.from(nativePath.sep)]);
    return target.equals(base) || target.subarray(0, prefix.length).equals(prefix);
  }

  /** Сопоставляет зарезервированный префикс имени в том же каталоге, включая Windows-регистр. */
  function hasBufferPathPrefix(candidate: Buffer, prefix: Buffer): boolean {
    const base = comparisonBuffer(prefix);
    return comparisonBuffer(candidate).subarray(0, base.length).equals(base);
  }

  return {
    nativePath,
    validateNativePath,
    pathIdentityKey,
    samePath,
    isPathWithin,
    relativePathParts,
    assertResourceNames,
    childBufferPath,
    isBufferPathWithin,
    hasBufferPathPrefix,
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
  assertResourceNames,
  childBufferPath,
  isBufferPathWithin,
  hasBufferPathPrefix,
} = createPathOperations();
