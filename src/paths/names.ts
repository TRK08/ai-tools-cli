import { StateError } from '@/errors';

const reservedName = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/iu;

/** Проверяет компонент Windows-пути, включая device names и лимит UTF-16, не меняя его текст. */
export function assertWindowsName(name: string): void {
  const device = name.split('.')[0]!.replace(/ +$/u, '');
  if (
    !name ||
    /[\uD800-\uDFFF]/u.test(name) ||
    name === '.' ||
    name === '..' ||
    /[<>:"/\\|?*\p{Cc}]/u.test(name) ||
    /[. ]$/u.test(name) ||
    reservedName.test(device) ||
    name.length > 255
  ) {
    throw new StateError(
      'INVALID_PATH',
      'Непереносимое имя объекта: ' + JSON.stringify(name) + '.',
    );
  }
}

/**
 * Проверяет компонент пути, представимый на Windows и POSIX, без изменения имени.
 * Buffer должен содержать корректный UTF-8; ошибка не создаёт файлов.
 */
export function assertPortableName(input: string | Buffer): void {
  const name = typeof input === 'string' ? input : input.toString('utf8');
  assertWindowsName(name);
  if (
    (Buffer.isBuffer(input) && !Buffer.from(name).equals(input)) ||
    Buffer.byteLength(name, 'utf8') > 255
  ) {
    throw new StateError(
      'INVALID_PATH',
      'Непереносимое имя объекта: ' + JSON.stringify(name) + '.',
    );
  }
}

/** Возвращает ключ коллизий имени по NFC и регистру; исходное имя для I/O не изменяется. */
export function portableNameKey(name: string | Buffer): string {
  assertPortableName(name);
  return name.toString().normalize('NFC').toLowerCase();
}

/** Отклоняет совпадения имён по NFC/регистру до создания содержимого каталога. */
export function assertPortableNames(names: readonly (string | Buffer)[]): void {
  const seen = new Map<string, string>();
  for (const name of names) {
    const key = portableNameKey(name);
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new StateError(
        'INVALID_PATH',
        'Коллизия переносимых имён: ' +
          JSON.stringify(previous) +
          ' и ' +
          JSON.stringify(name.toString()) +
          '.',
      );
    }
    seen.set(key, name.toString());
  }
}
