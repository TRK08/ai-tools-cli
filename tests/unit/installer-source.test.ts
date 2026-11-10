import { expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareSelectedSource, selectSource } from '@/installer/source';
import { getStatePaths } from '@/state/paths';
import { withTestEnvironment } from '../helpers/test-environment.ts';

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

it.each([
  { input: 'folder.tgz', directory: true, kind: 'directory', policy: 'local' },
  { input: 'archive.tgz', directory: false, kind: 'archive', policy: 'local' },
  { input: 'demo', kind: 'registry', policy: 'latest' },
  { input: 'demo@1.2.3', kind: 'registry', policy: 'exact' },
] as const)('selects $input without preparation or HTTP', async (entry) => {
  await withTestEnvironment(async (fixture) => {
    if ('directory' in entry) {
      const path = join(fixture.roots.cwd, entry.input);
      if (entry.directory) await mkdir(path);
      else await writeFile(path, 'not prepared yet');
    }
    const http = vi.fn(fixture.http);
    const selected = await selectSource(
      entry.input,
      { ...fixture, http },
      getStatePaths(fixture.roots, 'project'),
      {},
    );
    expect(selected.identity.kind).toBe(entry.kind);
    expect(selected.policy).toBe(entry.policy);
    expect(selected.artifact).toBeNull();
    expect(http).not.toHaveBeenCalled();
  });
});
