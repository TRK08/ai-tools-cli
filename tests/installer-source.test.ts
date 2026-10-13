import { expect, it } from 'vitest';
import { prepareSelectedSource, selectSource } from '../src/installer/source.ts';
import { getStatePaths } from '../src/state/paths.ts';
import { withTestEnvironment } from './helpers/test-environment.ts';

it('rejects preparation before the registry version is resolved without starting HTTP', async () => {
  const requests: string[] = [];
  await withTestEnvironment(
    async (fixture) => {
      const selected = await selectSource(
        'demo',
        fixture,
        getStatePaths(fixture.roots, 'project'),
        {},
      );
      await expect(
        prepareSelectedSource(selected, {
          cwd: fixture.roots.cwd,
          temporaryDirectory: fixture.temporaryRoot,
        }),
      ).rejects.toThrow('Выбранный registry-источник не содержит разрешённого артефакта.');
      expect(requests).toEqual([]);
    },
    {
      http: async (input) => {
        requests.push(String(input));
        throw new Error('Unresolved preparation must not contact the registry.');
      },
    },
  );
});
