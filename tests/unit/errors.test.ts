import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { errorMessage } from '../../src/errors.ts';
import { StateError } from '../../src/state/errors.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

it('localizes a native filesystem failure and preserves its code and both paths', async () => {
  await withTestEnvironment(async (context) => {
    const source = join(context.roots.cwd, 'Source name with spaces');
    const destination = join(context.roots.cwd, 'Destination имя');
    try {
      await rename(source, destination);
      throw new Error('Expected rename to fail');
    } catch (cause) {
      expect(cause).toMatchObject({ code: 'ENOENT', syscall: 'rename' });
      const message = errorMessage(cause);
      expect(message).toContain('Файл или каталог не найден');
      expect(message).toContain('ENOENT');
      expect(message).toContain(source);
      expect(message).toContain(destination);
      expect(message).not.toContain('no such file or directory');
    }
  });
});

it('preserves a domain diagnostic verbatim, including English skill data', () => {
  const error = new StateError(
    'SOURCE_CONFLICT',
    'У скилла "Source name" уже есть другой источник.',
  );
  expect(errorMessage(error)).toBe(error.message);
});
