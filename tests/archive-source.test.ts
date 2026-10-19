import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { create, Pax } from 'tar';
import { describe, expect, it, vi } from 'vitest';
import { ARCHIVE_LIMITS, prepareArchive } from '../src/sources/archive.ts';
import { prepareDirectory } from '../src/sources/directory.ts';
import { archiveSourceFileSystem } from '../src/sources/filesystem.ts';
import { hashDirectory } from '../src/state/hash.ts';
import { archiveBytes, rawTar, skillText, type TarFixtureEntry } from './helpers/archive.ts';
import { withTestEnvironment, type TestEnvironment } from './helpers/test-environment.ts';

function options(f: TestEnvironment) {
  return { cwd: f.roots.cwd, temporaryDirectory: f.env.TMPDIR! };
}

async function rejected(entries: readonly TarFixtureEntry[], message: RegExp) {
  await withTestEnvironment(async (f) => {
    const sentinel = join(f.roots.home, 'sentinel');
    await writeFile(sentinel, 'untouched');
    const path = join(f.roots.cwd, 'demo.tgz');
    await writeFile(path, archiveBytes([{ path: 'SKILL.md', contents: skillText }, ...entries]));
    const before = await hashDirectory(f.temporaryRoot);
    await expect(prepareArchive(path, options(f))).rejects.toThrow(message);
    expect(await hashDirectory(f.temporaryRoot)).toBe(before);
    expect(await readFile(sentinel, 'utf8')).toBe('untouched');
    expect(await readdir(f.env.TMPDIR!)).toEqual([]);
  });
}

describe('local gzip/tar preparation', () => {
  it.each(['tar.gz', 'tgz'])(
    'preserves a real %s archive at root and in one outer folder',
    async (extension) => {
      await withTestEnvironment(async (f) => {
        const source = join(f.roots.cwd, 'source');
        await mkdir(join(source, 'resources'), { recursive: true });
        await mkdir(join(source, 'empty'));
        await writeFile(join(source, 'SKILL.md'), skillText);
        const binary = Buffer.from([0, 255, 1, 254, 128]);
        await writeFile(join(source, 'resources', 'binary'), binary);
        await writeFile(join(source, 'run.sh'), '#!/bin/sh\nprintf demo\n');
        await chmod(join(source, 'run.sh'), 0o711);
        const directory = await prepareDirectory(source, options(f));
        try {
          for (const outer of [false, true]) {
            const archive = join(f.roots.cwd, `demo-${outer}.${extension}`);
            await create(
              { file: archive, gzip: true, portable: true, cwd: outer ? f.roots.cwd : source },
              [outer ? 'source' : '.'],
            );
            const prepared = await prepareArchive(archive, options(f));
            try {
              expect(prepared.name).toBe('demo');
              expect(prepared.identity).toEqual({ kind: 'archive', path: archive });
              expect(prepared.version).toBeNull();
              expect(prepared.archiveHash).toBe(
                createHash('sha256')
                  .update(await readFile(archive))
                  .digest('hex'),
              );
              expect(prepared.contentHash).toBe(directory.contentHash);
              expect(await readFile(join(prepared.directory, 'resources', 'binary'))).toEqual(
                binary,
              );
              expect((await lstat(join(prepared.directory, 'run.sh'))).mode & 0o777).toBe(0o711);
              expect(await readdir(join(prepared.directory, 'empty'))).toEqual([]);
            } finally {
              await prepared.cleanup();
              await prepared.cleanup();
            }
          }
        } finally {
          await directory.cleanup();
        }
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
      });
    },
  );

  it('uses the root SKILL.md even with another nested SKILL.md and unrelated top-level resources', async () => {
    await withTestEnvironment(async (f) => {
      const path = join(f.roots.cwd, 'demo.tgz');
      await writeFile(
        path,
        archiveBytes([
          { path: './SKILL.md', contents: skillText },
          { path: 'other/SKILL.md', contents: 'not metadata' },
          { path: 'resource', contents: 'root resource' },
        ]),
      );
      const prepared = await prepareArchive(path, options(f));
      try {
        expect(await readFile(join(prepared.directory, 'other', 'SKILL.md'), 'utf8')).toBe(
          'not metadata',
        );
      } finally {
        await prepared.cleanup();
      }
    });
  });

  it('keeps an archive symlink pathname as permanent identity', async () => {
    await withTestEnvironment(async (f) => {
      const target = join(f.roots.home, 'original.tgz');
      await writeFile(target, archiveBytes([{ path: 'SKILL.md', contents: skillText }]));
      await symlink(target, join(f.roots.cwd, 'alias.tgz'));
      const prepared = await prepareArchive('./alias.tgz', options(f));
      try {
        expect(prepared.identity).toEqual({
          kind: 'archive',
          path: join(f.roots.cwd, 'alias.tgz'),
        });
      } finally {
        await prepared.cleanup();
      }
    });
  });

  it.each([
    [],
    [{ path: 'readme', contents: 'missing' }],
    [{ path: 'outer/nested/SKILL.md', contents: skillText }],
    [
      { path: 'one/SKILL.md', contents: skillText },
      { path: 'two/SKILL.md', contents: skillText },
    ],
    [
      { path: 'one/SKILL.md', contents: skillText },
      { path: 'readme', contents: 'extra' },
    ],
    [{ path: 'SKILL.md/', type: 'Directory' as const }],
  ])('rejects missing or ambiguous skill roots %#', async (...entries) => {
    // it.each spreads each row; keep the complete row through the rest parameter.
    await withTestEnvironment(async (f) => {
      const path = join(f.roots.cwd, 'demo.tgz');
      await writeFile(path, archiveBytes(entries));
      await expect(prepareArchive(path, options(f))).rejects.toThrow(
        /SKILL.md|Некорректный.*архив/,
      );
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
    });
  });

  it.each([
    '../escape',
    'a/../../escape',
    'a/../escape',
    '/absolute',
    'C:/escape',
    'C:escape',
    './C:/escape',
    '..\\escape',
    '\\absolute',
    './..//escape',
  ])('rejects path %s before any filesystem writes', async (path) =>
    rejected([{ path, contents: 'attack' }], /небезопасный путь/),
  );

  it.each([
    'SymbolicLink',
    'Link',
    'FIFO',
    'CharacterDevice',
    'BlockDevice',
    'ContiguousFile',
    'GNUDumpDir',
    'Unsupported',
  ] as const)('rejects %s entries rather than skipping them', async (type) =>
    rejected(
      [
        {
          path: 'unsafe',
          type,
          ...(['SymbolicLink', 'Link'].includes(type) ? { linkpath: '../outside' } : {}),
        },
      ],
      /специальные|неподдерживаемую/,
    ),
  );

  it('validates the effective path supplied by PAX metadata', async () => {
    await withTestEnvironment(async (f) => {
      const pax = new Pax({ path: '../escape' }).encode();
      const path = join(f.roots.cwd, 'demo.tgz');
      await writeFile(
        path,
        gzipSync(Buffer.concat([pax!, rawTar([{ path: 'SKILL.md', contents: skillText }])])),
      );
      await expect(prepareArchive(path, options(f))).rejects.toThrow(/небезопасный путь/);
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
    });
  });

  it.each(['pax', 'gnu'] as const)(
    'preserves a valid long path supplied by %s metadata',
    async (kind) => {
      await withTestEnvironment(async (f) => {
        const long = 'resource-'.repeat(20);
        const metadata =
          kind === 'pax'
            ? new Pax({ path: long }).encode()
            : rawTar(
                [{ path: '././@LongLink', type: 'NextFileHasLongPath', contents: `${long}\0` }],
                0,
              );
        const bytes = Buffer.concat([
          rawTar([{ path: 'SKILL.md', contents: skillText }], 0),
          metadata,
          rawTar([{ path: 'placeholder', contents: 'long-name bytes' }]),
        ]);
        const path = join(f.roots.cwd, 'demo.tgz');
        await writeFile(path, gzipSync(bytes));
        const prepared = await prepareArchive(path, options(f));
        try {
          expect(await readFile(join(prepared.directory, long), 'utf8')).toBe('long-name bytes');
        } finally {
          await prepared.cleanup();
        }
      });
    },
  );

  it('rejects oversized metadata instead of silently ignoring it', async () => {
    await withTestEnvironment(async (f) => {
      const path = join(f.roots.cwd, 'demo.tgz');
      await writeFile(
        path,
        archiveBytes([
          { path: 'SKILL.md', contents: skillText },
          { path: 'metadata', type: 'ExtendedHeader', contents: Buffer.alloc(1024 * 1024 + 1, 65) },
        ]),
      );
      await expect(prepareArchive(path, options(f))).rejects.toThrow(/слишком большие метаданные/);
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
    });
  });

  it.each([
    [
      { path: 'resource', contents: 'first' },
      { path: './resource', contents: 'second' },
    ],
    [
      { path: 'folder', contents: 'file' },
      { path: 'folder/child', contents: 'child' },
    ],
  ])('rejects duplicate paths and file/directory conflicts %#', async (...entries) =>
    rejected(entries, /Повторяющийся|также используется/),
  );

  it.each([
    'not-gzip',
    'bad-gzip',
    'truncated-gzip',
    'bad-checksum',
    'truncated-body',
    'no-end',
    'one-end',
    'partial-header',
    'aligned-trailing-data',
    'concatenated-tar',
  ])('rejects %s data and leaves no temporary output', async (kind) => {
    await withTestEnvironment(async (f) => {
      const tar = rawTar([{ path: 'SKILL.md', contents: skillText }]);
      let bytes: Buffer = gzipSync(tar);
      if (kind === 'not-gzip') bytes = tar;
      if (kind === 'bad-gzip') bytes[bytes.length - 8] = bytes[bytes.length - 8]! ^ 0xff;
      if (kind === 'truncated-gzip') bytes = bytes.subarray(0, bytes.length - 6);
      if (kind === 'bad-checksum') {
        tar[10] = tar[10]! ^ 1;
        bytes = gzipSync(tar);
      }
      if (kind === 'truncated-body') bytes = gzipSync(tar.subarray(0, 520));
      if (kind === 'no-end') bytes = gzipSync(tar.subarray(0, 1024));
      if (kind === 'one-end') bytes = gzipSync(tar.subarray(0, 1536));
      if (kind === 'partial-header')
        bytes = gzipSync(Buffer.concat([tar, Buffer.from('trailing')]));
      if (kind === 'aligned-trailing-data')
        bytes = gzipSync(Buffer.concat([tar, Buffer.alloc(512, 1)]));
      if (kind === 'concatenated-tar') bytes = gzipSync(Buffer.concat([tar, tar]));
      const path = join(f.roots.cwd, 'demo.tgz');
      await writeFile(path, bytes);
      await expect(prepareArchive(path, options(f))).rejects.toMatchObject({
        code: 'INVALID_ARCHIVE',
      });
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
    });
  });

  it('enforces the actual compressed input limit', async () => {
    await withTestEnvironment(async (f) => {
      const path = join(f.roots.cwd, 'demo.tgz');
      await writeFile(path, randomBytes(ARCHIVE_LIMITS.inputBytes + 1));
      await expect(prepareArchive(path, options(f))).rejects.toThrow(/20 МиБ/);
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
    });
  });

  it('checks actual input bytes even if the opened file reports a smaller size', async () => {
    await withTestEnvironment(async (f) => {
      const path = join(f.roots.cwd, 'demo.tgz');
      await writeFile(path, Buffer.alloc(ARCHIVE_LIMITS.inputBytes + 1));
      await expect(
        prepareArchive(path, {
          ...options(f),
          fileSystem: {
            ...archiveSourceFileSystem,
            open: async (...args) => {
              const handle = await archiveSourceFileSystem.open(...args);
              const stats = await handle.stat({ bigint: true });
              stats.size = 1n;
              vi.spyOn(handle, 'stat').mockResolvedValue(stats);
              return handle;
            },
          },
        }),
      ).rejects.toThrow(/20 МиБ/);
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
    });
  });

  it.each([false, true])(
    'enforces the 25 MiB limit with declared sizes or trailing inflated data: %s',
    async (padding) => {
      await withTestEnvironment(async (f) => {
        const path = join(f.roots.cwd, 'demo.tgz');
        const bytes = padding
          ? gzipSync(
              Buffer.concat([
                rawTar([{ path: 'SKILL.md', contents: skillText }]),
                Buffer.alloc(30 * 1024 * 1024),
              ]),
            )
          : archiveBytes([
              { path: 'SKILL.md', contents: skillText },
              { path: 'large', contents: Buffer.alloc(ARCHIVE_LIMITS.extractedBytes) },
            ]);
        await writeFile(path, bytes);
        await expect(prepareArchive(path, options(f))).rejects.toMatchObject({
          code: 'ARCHIVE_LIMIT',
        });
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
      });
    },
  );

  it.each(['File', 'Directory'] as const)(
    'counts actual %s records including empty entries',
    async (type) => {
      await withTestEnvironment(async (f) => {
        const path = join(f.roots.cwd, 'demo.tgz');
        await writeFile(
          path,
          archiveBytes([
            { path: 'SKILL.md', contents: skillText },
            ...Array.from({ length: 1000 }, (_, index) => ({ path: `entry-${index}`, type })),
          ]),
        );
        await expect(prepareArchive(path, options(f))).rejects.toThrow(
          /записей в архиве превышает ограничение 1000/,
        );
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
      });
    },
  );

  it('accepts the exact extracted-byte and entry limits', async () => {
    await withTestEnvironment(async (f) => {
      const path = join(f.roots.cwd, 'demo.tgz');
      await writeFile(
        path,
        archiveBytes([
          { path: 'SKILL.md', contents: skillText },
          {
            path: 'large',
            contents: Buffer.alloc(ARCHIVE_LIMITS.extractedBytes - Buffer.byteLength(skillText)),
          },
          ...Array.from({ length: 998 }, (_, index) => ({ path: `empty-${index}` })),
        ]),
      );
      const prepared = await prepareArchive(path, options(f));
      try {
        expect((await readdir(prepared.directory)).length).toBe(1000);
      } finally {
        await prepared.cleanup();
      }
    });
  });

  it('cleans extracted output after invalid metadata', async () => {
    await withTestEnvironment(async (f) => {
      const path = join(f.roots.cwd, 'demo.tgz');
      await writeFile(
        path,
        archiveBytes([
          { path: 'SKILL.md', contents: '---\nname: ../escape\ndescription: Invalid\n---\n' },
        ]),
      );
      await expect(prepareArchive(path, options(f))).rejects.toMatchObject({
        code: 'INVALID_METADATA',
      });
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
    });
  });

  it.each(['file-write', 'file-chmod', 'metadata-read'])(
    'cleans partial extraction after injected %s failure',
    async (failure) => {
      await withTestEnvironment(async (f) => {
        const path = join(f.roots.cwd, 'demo.tgz');
        const bytes = archiveBytes([{ path: 'SKILL.md', contents: skillText }]);
        await writeFile(path, bytes);
        let calls = 0;
        await expect(
          prepareArchive(path, {
            ...options(f),
            fileSystem: {
              ...archiveSourceFileSystem,
              readFile:
                failure === 'metadata-read'
                  ? vi.fn(async () => {
                      calls++;
                      throw new Error('metadata read failed');
                    })
                  : archiveSourceFileSystem.readFile,
              open: async (...args) => {
                const handle = await archiveSourceFileSystem.open(...args);
                if (args[1] === 'wx') {
                  if (failure === 'file-write') {
                    await handle.writeFile('partial');
                    vi.spyOn(handle, 'write').mockImplementation(async () => {
                      calls++;
                      throw new Error('write failed');
                    });
                  }
                  if (failure === 'file-chmod')
                    vi.spyOn(handle, 'chmod').mockImplementation(async () => {
                      calls++;
                      throw new Error('chmod failed');
                    });
                }
                return handle;
              },
            },
          }),
        ).rejects.toMatchObject({ code: 'PREPARATION_FAILED' });
        expect(calls).toBe(1);
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
        expect(await readFile(path)).toEqual(bytes);
      });
    },
  );

  it('reports the owned workspace and both errors when cleanup is blocked', async () => {
    await withTestEnvironment(async (f) => {
      const path = join(f.roots.cwd, 'demo.tgz');
      await writeFile(path, archiveBytes([{ path: 'SKILL.md', contents: 'bad metadata' }]));
      const cleanupError = new Error('cleanup failed');
      await expect(
        prepareArchive(path, {
          ...options(f),
          fileSystem: { ...archiveSourceFileSystem, rm: vi.fn().mockRejectedValue(cleanupError) },
        }),
      ).rejects.toMatchObject({
        code: 'PREPARATION_FAILED',
        message: expect.stringContaining('skills-installer-archive-'),
        cause: expect.objectContaining({
          errors: [expect.objectContaining({ code: 'INVALID_METADATA' }), cleanupError],
        }),
      });
      expect(await readdir(f.env.TMPDIR!)).toHaveLength(1);
    });
  });

  it.each(['missing', 'directory', 'zip-extension', 'relative-base'])(
    'rejects %s sources',
    async (kind) => {
      await withTestEnvironment(async (f) => {
        const path = join(f.roots.cwd, kind === 'zip-extension' ? 'demo.zip' : 'demo.tgz');
        if (kind === 'directory') await mkdir(path);
        if (kind === 'zip-extension' || kind === 'relative-base')
          await writeFile(path, archiveBytes([{ path: 'SKILL.md', contents: skillText }]));
        await expect(
          prepareArchive(path, {
            ...options(f),
            ...(kind === 'relative-base' ? { temporaryDirectory: '.' } : {}),
          }),
        ).rejects.toBeInstanceOf(Error);
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
      });
    },
  );
});
