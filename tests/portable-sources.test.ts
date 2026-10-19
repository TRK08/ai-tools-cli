import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { prepareDirectory } from '../src/sources/directory.ts';
import { prepareArchive } from '../src/sources/archive.ts';
import { prepareRegistrySource } from '../src/sources/registry.ts';
import { RegistryClient } from '../src/registry/client.ts';
import { artifact } from './helpers/registry.ts';
import {
  archiveSourceFileSystem,
  directorySourceFileSystem,
  OWNED_WORKSPACE_CLEANUP,
} from '../src/sources/filesystem.ts';
import {
  localSourceIdentity,
  prepareLocalSource,
  registryReferenceForSource,
} from '../src/sources/local.ts';
import { preparationOptions } from '../src/installer/source.ts';
import { getStatePaths } from '../src/state/paths.ts';
import { archiveBytes, rawTar, skillText, type TarFixtureEntry } from './helpers/archive.ts';
import { withTestEnvironment } from './helpers/test-environment.ts';

const invalidNames = [
  'CON',
  'nul.txt',
  'COM1',
  'bad:stream',
  'trailing.',
  'trailing ',
  'bad\\name',
  Buffer.from([0xff, 0xfe]),
];
const collisions = [
  ['A', 'a'],
  ['café', 'cafe\u0301'],
];

describe('portable source preparation', () => {
  it.each([...invalidNames.map((name) => [name]), ...collisions])(
    'rejects a directory name list %j before copying children',
    async (...names) => {
      await withTestEnvironment(async (f) => {
        const mkdtemp = vi.fn(directorySourceFileSystem.mkdtemp),
          openSpy = vi.fn(open);
        const fs = {
          ...directorySourceFileSystem,
          mkdtemp,
          open: openSpy,
          readdir: async () => [Buffer.from('SKILL.md'), ...names.map((name) => Buffer.from(name))],
        };
        await expect(
          prepareDirectory('.', {
            cwd: f.roots.cwd,
            temporaryDirectory: f.env.TMPDIR!,
            fileSystem: fs,
          }),
        ).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
        expect(openSpy).not.toHaveBeenCalled();
        expect(mkdtemp).not.toHaveBeenCalled();
      });
    },
  );

  it.each(['skill.md', 'SKILL.MD'])(
    'requires exact SKILL.md even if lstat would accept %s',
    async (name) => {
      await withTestEnvironment(async (f) => {
        await writeFile(join(f.roots.cwd, 'SKILL.md'), skillText);
        const openSpy = vi.fn(open);
        await expect(
          prepareDirectory('.', {
            cwd: f.roots.cwd,
            temporaryDirectory: f.env.TMPDIR!,
            fileSystem: {
              ...directorySourceFileSystem,
              open: openSpy,
              readdir: async () => [Buffer.from(name)],
            },
          }),
        ).rejects.toThrow('точное имя SKILL.md');
        expect(openSpy).not.toHaveBeenCalled();
      });
    },
  );

  it.each(['directory', 'archive'] as const)(
    'preserves Unicode resources and short writes in %s',
    async (kind) => {
      await withTestEnvironment(async (f) => {
        const resource = 'Каталог с пробелами/工具😀.bin',
          bytes = Buffer.from([0, 255, 128, 254, 1]);
        const path = join(f.roots.cwd, kind === 'archive' ? 'Скилл.TAR.GZ' : 'Скилл');
        if (kind === 'archive')
          await writeFile(
            path,
            archiveBytes([
              { path: 'SKILL.md', contents: skillText },
              { path: resource, contents: bytes },
              { path: '.hidden', contents: 'hidden' },
            ]),
          );
        else {
          await mkdir(join(path, 'Каталог с пробелами'), { recursive: true });
          await writeFile(join(path, 'SKILL.md'), skillText);
          await writeFile(join(path, resource), bytes);
          await writeFile(join(path, '.hidden'), 'hidden');
        }
        let shortWrites = 0;
        const fs = {
          ...(kind === 'archive' ? archiveSourceFileSystem : directorySourceFileSystem),
          open: async (...args: Parameters<typeof open>) => {
            const handle = await open(...args);
            if (args[1] === 'wx') {
              const write = handle.write.bind(handle);
              vi.spyOn(handle, 'write').mockImplementation((async (
                buffer: Buffer,
                offset: number,
                length: number,
                position: number | null,
              ) => {
                shortWrites++;
                return write(buffer, offset, Math.min(length, 2), position);
              }) as typeof handle.write);
            }
            return handle;
          },
        };
        const prepared =
          kind === 'archive'
            ? await prepareArchive(path, {
                cwd: f.roots.cwd,
                temporaryDirectory: f.env.TMPDIR!,
                fileSystem: { ...archiveSourceFileSystem, open: fs.open },
              })
            : await prepareDirectory(path, {
                cwd: f.roots.cwd,
                temporaryDirectory: f.env.TMPDIR!,
                fileSystem: { ...directorySourceFileSystem, open: fs.open },
              });
        try {
          expect(await readFile(join(prepared.directory, resource))).toEqual(bytes);
          expect(await readFile(join(prepared.directory, '.hidden'), 'utf8')).toBe('hidden');
          expect(shortWrites).toBeGreaterThan(4);
        } finally {
          await prepared.cleanup();
        }
      });
    },
  );

  it.each(['TGZ', 'TAR.GZ'])(
    'recognizes .%s without converting absent files to registry slugs',
    async (extension) => {
      await withTestEnvironment(async (f) => {
        const path = 'skill.' + extension;
        expect(await registryReferenceForSource(path, f.roots.cwd)).toBeNull();
        expect((await localSourceIdentity(path, f.roots.cwd)).kind).toBe('archive');
        await writeFile(
          join(f.roots.cwd, path),
          archiveBytes([{ path: 'SKILL.md', contents: skillText }]),
        );
        const prepared = await prepareLocalSource(path, {
          cwd: f.roots.cwd,
          temporaryDirectory: f.env.TMPDIR!,
        });
        await prepared.cleanup();
        await mkdir(join(f.roots.cwd, 'directory.' + extension));
        await writeFile(join(f.roots.cwd, 'directory.' + extension, 'SKILL.md'), skillText);
        expect((await localSourceIdentity('directory.' + extension, f.roots.cwd)).kind).toBe(
          'directory',
        );
      });
    },
  );

  it.each([
    ...invalidNames
      .filter((name) => typeof name === 'string' && name !== 'bad\\name')
      .map((name) => [{ path: name }]),
    ...collisions.map((names) => names.map((name) => ({ path: name + '/resource' }))),
    [{ path: 'file' }, { path: 'file/child' }],
  ] as TarFixtureEntry[][])(
    'rejects tar names and implicit parent collisions before creating a workspace: %j',
    async (...entries) => {
      await withTestEnvironment(async (f) => {
        const path = join(f.roots.cwd, 'demo.tgz');
        await writeFile(
          path,
          archiveBytes([{ path: 'SKILL.md', contents: skillText }, ...entries]),
        );
        const mkdtemp = vi.fn(archiveSourceFileSystem.mkdtemp);
        await expect(
          prepareArchive(path, {
            cwd: f.roots.cwd,
            temporaryDirectory: f.env.TMPDIR!,
            fileSystem: { ...archiveSourceFileSystem, mkdtemp },
          }),
        ).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
        expect(mkdtemp).not.toHaveBeenCalled();
      });
    },
  );

  it.each(['header', 'pax', 'gnu'] as const)(
    'rejects invalid UTF-8 in a raw %s name before disk writes',
    async (kind) => {
      await withTestEnvironment(async (f) => {
        let tail: Buffer;
        if (kind === 'header') {
          tail = rawTar([{ path: 'x', contents: 'resource' }]);
          tail[0] = 0xff;
          tail.fill(32, 148, 156);
          const checksum = tail.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
          tail.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
        } else {
          const contents =
            kind === 'gnu'
              ? Buffer.from([0xff, 0])
              : Buffer.concat([Buffer.from('10 path='), Buffer.from([0xff]), Buffer.from('\n')]);
          tail = Buffer.concat([
            rawTar(
              [
                {
                  path: 'metadata',
                  type: kind === 'gnu' ? 'NextFileHasLongPath' : 'ExtendedHeader',
                  contents,
                },
              ],
              0,
            ),
            rawTar([{ path: 'placeholder', contents: 'resource' }]),
          ]);
        }
        const path = join(f.roots.cwd, 'demo.tgz');
        await writeFile(
          path,
          gzipSync(Buffer.concat([rawTar([{ path: 'SKILL.md', contents: skillText }], 0), tail])),
        );
        const mkdtemp = vi.fn(archiveSourceFileSystem.mkdtemp);
        await expect(
          prepareArchive(path, {
            cwd: f.roots.cwd,
            temporaryDirectory: f.env.TMPDIR!,
            fileSystem: { ...archiveSourceFileSystem, mkdtemp },
          }),
        ).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
        expect(mkdtemp).not.toHaveBeenCalled();
      });
    },
  );

  it('passes scope policy through local archives and keeps native POSIX names explicit', async () => {
    await withTestEnvironment(async (f) => {
      const path = join(f.roots.cwd, 'demo.tgz');
      await writeFile(
        path,
        archiveBytes([
          { path: 'SKILL.md', contents: skillText },
          { path: 'CON', contents: 'resource' },
        ]),
      );
      await expect(
        prepareLocalSource(path, { cwd: f.roots.cwd, temporaryDirectory: f.env.TMPDIR! }),
      ).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
      if (process.platform !== 'win32') {
        const prepared = await prepareLocalSource(path, {
          cwd: f.roots.cwd,
          temporaryDirectory: f.env.TMPDIR!,
          portableNames: false,
        });
        try {
          expect(await readFile(join(prepared.directory, 'CON'), 'utf8')).toBe('resource');
        } finally {
          await prepared.cleanup();
        }
      }
      expect(
        preparationOptions(f, getStatePaths(f.roots, 'project'), f.env.TMPDIR!).portableNames,
      ).toBe(true);
      expect(
        preparationOptions(f, getStatePaths(f.roots, 'global'), f.env.TMPDIR!).portableNames,
      ).toBe(false);
    });
  });

  it('passes portableNames through registry preparation and keeps digest/version/download contracts', async () => {
    await withTestEnvironment(async (f) => {
      const bytes = archiveBytes([
        { path: 'SKILL.md', contents: skillText },
        { path: 'CON', contents: 'native resource' },
      ]);
      const selected = artifact('https://registry.test/download', {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      });
      const client = new RegistryClient(
        'https://registry.test',
        async () => new Response(new Uint8Array(bytes)),
      );
      const download = vi.fn();
      const options = { cwd: f.roots.cwd, temporaryDirectory: f.env.TMPDIR! };
      await expect(
        prepareRegistrySource({ slug: 'demo' }, client, options, download, selected),
      ).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
      expect(download).toHaveBeenCalledTimes(1);
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
      if (process.platform !== 'win32') {
        const prepared = await prepareRegistrySource(
          { slug: 'demo' },
          client,
          { ...options, portableNames: false },
          download,
          selected,
        );
        try {
          expect(prepared.version).toBe(selected.version);
          expect(prepared.archiveHash).toBe(selected.sha256);
          expect(prepared.identity).toEqual({
            kind: 'registry',
            registryUrl: client.registryUrl,
            slug: 'demo',
          });
          expect(await readFile(join(prepared.directory, 'CON'), 'utf8')).toBe('native resource');
        } finally {
          await prepared.cleanup();
        }
        expect(download).toHaveBeenCalledTimes(2);
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
      }
    });
  });

  it.each(['skill.md', 'SKILL.MD'])(
    'rejects archive metadata with the wrong case: %s',
    async (name) => {
      await withTestEnvironment(async (f) => {
        const path = join(f.roots.cwd, 'demo.tgz');
        await writeFile(path, archiveBytes([{ path: name, contents: skillText }]));
        await expect(
          prepareArchive(path, { cwd: f.roots.cwd, temporaryDirectory: f.env.TMPDIR! }),
        ).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
      });
    },
  );

  it('excludes both agent roots, env/saved destinations and realpath aliases while retaining similar resource names', async () => {
    await withTestEnvironment(async (f) => {
      const config = join(f.roots.cwd, 'configured'),
        saved = join(f.roots.cwd, 'saved', 'skills', 'demo');
      const context = { ...f, env: { ...f.env, CLAUDE_CONFIG_DIR: config } };
      await writeFile(join(f.roots.cwd, 'SKILL.md'), skillText);
      const paths = getStatePaths(f.roots, 'global');
      let aliasIndex = 0;
      for (const directory of [
        join(f.roots.cwd, '.agents', 'skills'),
        join(f.roots.cwd, '.claude', 'skills'),
        join(config, 'skills'),
        saved,
        join(f.roots.home, '.agents', 'skills'),
        join(f.roots.home, '.claude', 'skills'),
      ]) {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'installed'), 'must not copy');
        await symlink(directory, join(f.roots.cwd, 'alias-' + String(aliasIndex++)));
      }
      await mkdir(join(f.roots.cwd, 'resources'));
      await writeFile(join(f.roots.cwd, 'resources', 'skills-installer-lock.json'), 'resource');
      const record = {
        name: 'demo',
        source: { kind: 'directory' as const, path: f.roots.cwd },
        version: null,
        policy: 'local' as const,
        contentHash: 'a'.repeat(64),
        agents: ['claude-code' as const],
        connections: [{ agent: 'claude-code' as const, path: saved }],
      };
      const prepared = await prepareDirectory(
        '.',
        preparationOptions(context, paths, f.env.TMPDIR!, undefined, [record]),
      );
      try {
        expect(
          await readFile(
            join(prepared.directory, 'resources', 'skills-installer-lock.json'),
            'utf8',
          ),
        ).toBe('resource');
        expect((await readdir(prepared.directory)).some((name) => name.startsWith('alias-'))).toBe(
          false,
        );
        expect(await readdir(join(prepared.directory, 'configured'))).toEqual([]);
        expect(await readdir(join(prepared.directory, '.claude'))).toEqual([]);
        expect(await readdir(join(prepared.directory, 'saved', 'skills'))).toEqual([]);
      } finally {
        await prepared.cleanup();
      }
    });
  });

  it.each(['directory', 'archive'] as const)(
    'uses bounded cleanup only for the owned %s workspace',
    async (kind) => {
      await withTestEnvironment(async (f) => {
        const path = join(f.roots.cwd, kind === 'archive' ? 'demo.tgz' : 'demo');
        if (kind === 'archive')
          await writeFile(path, archiveBytes([{ path: 'SKILL.md', contents: skillText }]));
        else {
          await mkdir(path);
          await writeFile(join(path, 'SKILL.md'), skillText);
        }
        const rm = vi.fn(archiveSourceFileSystem.rm);
        const prepared =
          kind === 'archive'
            ? await prepareArchive(path, {
                cwd: f.roots.cwd,
                temporaryDirectory: f.env.TMPDIR!,
                fileSystem: { ...archiveSourceFileSystem, rm },
              })
            : await prepareDirectory(path, {
                cwd: f.roots.cwd,
                temporaryDirectory: f.env.TMPDIR!,
                fileSystem: { ...directorySourceFileSystem, rm },
              });
        await prepared.cleanup();
        expect(rm).toHaveBeenCalledWith(
          expect.stringContaining('skills-installer-'),
          OWNED_WORKSPACE_CLEANUP,
        );
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
      });
    },
  );
});
