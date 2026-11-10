import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AGENTS } from '@/agents/catalog';
import { Installer } from '@/installer/installer';
import type { AddPreview } from '@/installer/types';
import { prepareLocalSource } from '@/sources/local';
import { hashDirectory } from '@/state/hash';
import { getStatePaths } from '@/state/paths';
import { Telemetry } from '@/telemetry/client';
import { archiveBytes, skillText } from '../helpers/archive.ts';
import { withTestEnvironment, type TestEnvironment } from '../helpers/test-environment.ts';
import { versionRegistry } from '../helpers/versions.ts';

async function localSource(f: TestEnvironment, archive: boolean) {
  const path = join(f.roots.cwd, archive ? 'demo.tgz' : 'demo');
  if (archive) await writeFile(path, archiveBytes([{ path: 'SKILL.md', contents: skillText }]));
  else {
    await mkdir(path);
    await writeFile(join(path, 'SKILL.md'), skillText);
  }
  return path;
}
const agents = AGENTS.map((agent) => agent.id);

describe('installation review lifecycle', () => {
  it.each(['directory', 'archive', 'registry'] as const)(
    'reviews %s once and installs the same snapshot into the shown destinations in both scopes',
    async (kind) => {
      for (const scope of ['project'] as readonly ('project' | 'global')[])
        await withTestEnvironment(async (f) => {
          const backend = versionRegistry();
          const source = kind === 'registry' ? 'demo' : await localSource(f, kind === 'archive');
          const paths = getStatePaths(f.roots, scope);
          const prepare = vi.fn(prepareLocalSource);
          let preview!: AddPreview;
          const reviewAdd = vi.fn(async (value: AddPreview) => {
            preview = value;
            expect(value.destinations.map((item) => item.agent)).toEqual(agents);
            expect(value.sharedDirectory).toBe(join(paths.skillsDirectory, 'demo'));
            await expect(lstat(paths.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
            if (kind === 'registry') {
              expect(backend.requests).toEqual([`${backend.url}/api/v1/skills/demo/artifact`]);
              backend.current.demo = '2.0.0';
            } else if (kind === 'directory') {
              expect(value.description).toBe('Demo skill');
              await writeFile(join(source, 'SKILL.md'), 'source changed after review');
            } else await writeFile(source, 'archive changed after review');
            return 'approve' as const;
          });
          const installer = new Installer(
            { ...f, http: backend.http },
            {
              scope,
              registry: backend.url,
              prepare,
              reviewAdd,
            },
          );
          expect((await installer.add(source, false, agents)).status).toBe('success');
          expect(reviewAdd).toHaveBeenCalledTimes(1);
          expect(prepare).toHaveBeenCalledTimes(kind === 'registry' ? 0 : 1);
          const record = (await installer.list())[0]!;
          expect(record.policy).toBe(kind === 'registry' ? 'latest' : 'local');
          expect(record.version).toBe(kind === 'registry' ? '1.0.0' : null);
          for (const { path } of preview.destinations) {
            expect(await realpath(path)).toBe(scope === 'project' ? path : preview.sharedDirectory);
            expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toContain('name: demo');
          }
        });
    },
  );

  it.each(['decline', 'cancel'] as const)(
    'returns %s without state, downloads or telemetry',
    async (decision) => {
      for (const scope of ['project'] as readonly ('project' | 'global')[])
        for (const kind of ['directory', 'archive', 'registry'] as const)
          await withTestEnvironment(async (f) => {
            const backend = versionRegistry();
            const http = vi.fn(backend.http);
            const context = {
              ...f,
              http,
              env: { ...f.env, DISABLE_TELEMETRY: '', DO_NOT_TRACK: '' },
            };
            const source = kind === 'registry' ? 'demo' : await localSource(f, kind === 'archive');
            const before = await hashDirectory(f.temporaryRoot);
            const telemetry = new Telemetry(context, '0.1.0');
            const installer = new Installer(context, {
              scope,
              registry: backend.url,
              telemetry,
              reviewAdd: async () => decision,
            });
            expect(await installer.add(source, true, agents)).toEqual({
              name: 'demo',
              status: 'skipped',
              reason: decision === 'cancel' ? 'cancelled' : 'declined',
            });
            await telemetry.flush();
            expect(await hashDirectory(f.temporaryRoot)).toBe(before);
            expect(backend.requests).toEqual(
              kind === 'registry' ? [`${backend.url}/api/v1/skills/demo/artifact`] : [],
            );
          });
    },
  );

  it('reviews intact repeats and preserves lock bytes when a policy change is declined', async () =>
    withTestEnvironment(async (f) => {
      const backend = versionRegistry();
      const context = { ...f, http: backend.http };
      const installer = new Installer(context, { registry: backend.url });
      await installer.add('demo');
      const paths = getStatePaths(f.roots, 'project');
      const before = await readFile(paths.lockPath);
      backend.requests.length = 0;
      const reviewAdd = vi.fn(async () => 'decline' as const);
      const reviewed = new Installer(context, { registry: backend.url, reviewAdd });
      expect((await reviewed.addRegistry({ slug: 'demo', version: '1.0.0' })).status).toBe(
        'skipped',
      );
      expect(reviewAdd).toHaveBeenCalledWith(
        expect.objectContaining({ policy: 'exact', version: '1.0.0' }),
      );
      expect(await readFile(paths.lockPath)).toEqual(before);
      expect(backend.requests).toHaveLength(1);
    }));

  it('shows the saved global connection paths after environment overrides change', async () =>
    withTestEnvironment(async (f) => {
      const source = await localSource(f, false);
      const requested = ['claude-code', 'opencode'] as const;
      const installer = new Installer(f, { scope: 'global' });
      await installer.add(source, false, requested);
      const saved = (await installer.list())[0]!.connections;
      const changed = {
        ...f,
        env: {
          ...f.env,
          CLAUDE_CONFIG_DIR: join(f.roots.home, 'new-claude'),
          XDG_CONFIG_HOME: join(f.roots.home, 'new-config'),
        },
      };
      const reviewAdd = vi.fn(async () => 'approve' as const);
      const result = await new Installer(changed, { scope: 'global', reviewAdd }).add(
        source,
        false,
        requested,
      );
      expect(result.status).toBe('unchanged');
      expect(reviewAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          destinations: saved.map(({ agent, path }) => ({ agent, path })),
        }),
      );
    }));

  it('unpins an intact exact installation with a reviewed latest selection without downloading again', async () =>
    withTestEnvironment(async (f) => {
      const backend = versionRegistry();
      const context = { ...f, http: backend.http };
      const installer = new Installer(context, { registry: backend.url });
      await installer.add('demo@1.0.0');
      backend.requests.length = 0;
      const reviewAdd = vi.fn(async () => 'approve' as const);
      const reviewed = new Installer(context, { registry: backend.url, reviewAdd });
      expect(
        await reviewed.addRegistry({ slug: 'demo', version: '1.0.0', policy: 'latest' }),
      ).toMatchObject({
        status: 'success',
        changes: { content: false, connections: false, metadata: true },
      });
      expect(reviewAdd).toHaveBeenCalledWith(
        expect.objectContaining({ policy: 'latest', version: '1.0.0' }),
      );
      expect(backend.requests).toEqual([
        `${backend.url}/api/v1/skills/demo/artifact?version=1.0.0`,
      ]);
      expect((await reviewed.list())[0]).toMatchObject({ version: '1.0.0', policy: 'latest' });
    }));
});
