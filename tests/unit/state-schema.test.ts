import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getStatePaths, StateStore, createEmptyLock, type LockFile } from '@/state';
import { parseLockFile, serializeLockFile } from '@/state/schema';
import { withTestEnvironment } from '../helpers/test-environment.ts';

const lock: LockFile = {
  version: 1,
  packages: [
    {
      slug: 'document',
      registryUrl: 'http://registry.test',
      version: '1.0.0',
      skills: [
        {
          name: 'check',
          installName: 'document-check',
          archiveHash: 'a'.repeat(64),
          contentHash: 'b'.repeat(64),
          connections: [
            { agent: 'pi', kind: 'direct', path: '.agents/skills/document-check' },
            { agent: 'codex', kind: 'direct', path: '.agents/skills/document-check' },
            { agent: 'claude-code', kind: 'link', path: '.claude/skills/document-check' },
          ],
        },
      ],
    },
  ],
};

interface WireLock {
  packages: {
    slug: string;
    registryUrl: string;
    version: string;
    policy?: string;
    skills: { archiveHash: string; connections: { agent: string; kind: string; path: string }[] }[];
  }[];
}

describe('lock version: 1', () => {
  it('round trips one version, multiple connections and portable project paths', async () => {
    await withTestEnvironment(async ({ roots }) => {
      const paths = getStatePaths(roots, 'project');
      const store = new StateStore(paths);
      expect(await store.read()).toBeNull();
      await store.write(lock);
      const bytes = await readFile(paths.lockPath, 'utf8');
      expect(bytes).not.toContain(roots.cwd);
      const pkg = (await store.read())!.packages[0]!;
      expect(pkg.version).toBe('1.0.0');
      expect(pkg.skills[0]?.connections.map((item) => item.agent)).toEqual([
        'claude-code',
        'codex',
        'pi',
      ]);
      expect(serializeLockFile((await store.read()) ?? createEmptyLock(), paths)).toBe(bytes);
    });
  });

  it.each([
    [
      'duplicate package',
      (value: WireLock): void => {
        value.packages.push(value.packages[0]!);
      },
    ],
    [
      'duplicate component',
      (value: WireLock): void => {
        value.packages[0]!.skills.push(value.packages[0]!.skills[0]!);
      },
    ],
    [
      'duplicate install name',
      (value: WireLock): void => {
        value.packages.push({ ...value.packages[0]!, slug: 'other' });
      },
    ],
    [
      'empty package',
      (value: WireLock): void => {
        value.packages[0]!.skills = [];
      },
    ],
    [
      'incorrect version',
      (value: WireLock): void => {
        value.packages[0]!.version = 'v1.0.0';
      },
    ],
    [
      'wrong hash',
      (value: WireLock): void => {
        value.packages[0]!.skills[0]!.archiveHash = 'wrong';
      },
    ],
    [
      'policy',
      (value: WireLock): void => {
        value.packages[0]!.policy = 'exact';
      },
    ],
    [
      'unsupported agent',
      (value: WireLock): void => {
        value.packages[0]!.skills[0]!.connections[0]!.agent = 'unknown';
      },
    ],
    [
      'wrong connection kind',
      (value: WireLock): void => {
        value.packages[0]!.skills[0]!.connections[0]!.kind = 'link';
      },
    ],
    [
      'wrong direct path',
      (value: WireLock): void => {
        value.packages[0]!.skills[0]!.connections[0]!.path = '.agents/skills/another';
      },
    ],
    [
      'path outside project',
      (value: WireLock): void => {
        value.packages[0]!.skills[0]!.connections[2]!.path = '../external/document-check';
      },
    ],
    [
      'temporary URL',
      (value: WireLock): void => {
        value.packages[0]!.registryUrl = 'https://storage.test/file?signature=temporary';
      },
    ],
  ] as const)('rejects %s', async (_name, change) => {
    await withTestEnvironment(async ({ roots }) => {
      const value = JSON.parse(JSON.stringify(lock));
      change(value);
      expect(() => parseLockFile(value, getStatePaths(roots, 'project'))).toThrow(
        expect.objectContaining({ code: 'INVALID_LOCK' }),
      );
    });
  });

  it.each([null, 99, '1'])(
    'refuses version %s and leaves existing bytes intact',
    async (version) => {
      await withTestEnvironment(async ({ roots }) => {
        const paths = getStatePaths(roots, 'project');
        const store = new StateStore(paths);
        const contents = JSON.stringify({ version, packages: [] });
        await writeFile(paths.lockPath, contents);
        await expect(store.read()).rejects.toThrow(/version: 1/);
        await expect(store.write(createEmptyLock())).rejects.toThrow(/version: 1/);
        expect(await readFile(paths.lockPath, 'utf8')).toBe(contents);
      });
    },
  );

  it('refuses changing registry for an existing package', async () => {
    await withTestEnvironment(async ({ roots }) => {
      const store = new StateStore(getStatePaths(roots, 'project'));
      await store.write(lock);
      const pkg = lock.packages[0]!;
      await expect(
        store.write({ ...lock, packages: [{ ...pkg, registryUrl: 'https://other.test' }] }),
      ).rejects.toThrow(/другого реестра/);
    });
  });
});
