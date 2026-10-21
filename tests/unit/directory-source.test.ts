import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { fileSymlinks, symlink } from '../helpers/links.ts';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { prepareDirectory, type PrepareDirectoryOptions } from '../../src/sources/directory.ts';
import { directorySourceFileSystem } from '../../src/sources/filesystem.ts';
import * as hashing from '../../src/state/hash.ts';
import { hashDirectory } from '../../src/state/hash.ts';
import { getStatePaths, portableSourcePath } from '../../src/state/paths.ts';
import { withTestEnvironment, type TestEnvironment } from '../helpers/test-environment.js';

const skillText = '---\nname: demo\ndescription: Demo skill\n---\nUse [scripts](scripts/run.sh).\n';

function options(fixture: TestEnvironment): PrepareDirectoryOptions {
  return { cwd: fixture.roots.cwd, temporaryDirectory: fixture.env.TMPDIR! };
}

async function makeSkill(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), skillText);
}

async function assertNoLinks(path: string): Promise<void> {
  const stats = await lstat(path);
  expect(stats.isSymbolicLink()).toBe(false);
  if (stats.isDirectory()) {
    for (const name of await readdir(path)) await assertNoLinks(join(path, name));
  }
}

describe('local directory source', () => {
  it('dereferences directory aliases and rejects modeled special entries without symlink privileges', async () => {
    await withTestEnvironment(async (f) => {
      const source = join(f.roots.cwd, 'source');
      const target = join(f.roots.home, 'resources');
      await makeSkill(source);
      await mkdir(target);
      await writeFile(join(target, 'resource'), 'bytes');
      await symlink(target, join(source, 'alias'));
      const prepared = await prepareDirectory(source, options(f));
      try {
        expect((await lstat(join(prepared.directory, 'alias'))).isSymbolicLink()).toBe(false);
        expect(await readFile(join(prepared.directory, 'alias', 'resource'), 'utf8')).toBe('bytes');
      } finally {
        await prepared.cleanup();
      }
      const resource = join(source, 'special');
      await writeFile(resource, 'must not open');
      const openSpy = vi.fn(open);
      await expect(
        prepareDirectory(source, {
          ...options(f),
          fileSystem: {
            ...directorySourceFileSystem,
            open: openSpy,
            lstat: async (path) => {
              const stats = await directorySourceFileSystem.lstat(path);
              return String(path) === resource
                ? Object.assign(Object.create(stats), {
                    isFile: () => false,
                    isDirectory: () => false,
                    isSymbolicLink: () => false,
                  })
                : stats;
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_ENTRY' });
      expect(openSpy.mock.calls.some(([path]) => String(path) === resource)).toBe(false);
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
    });
  });
  it('excludes new state files, installed copies and stale operation work without excluding cwd or resources', async () => {
    await withTestEnvironment(async (fixture) => {
      const source = fixture.roots.cwd;
      await writeFile(join(source, 'SKILL.md'), skillText);
      await writeFile(join(source, 'skills-installer-lock.json'), 'owned lock');
      await writeFile(join(source, '.skills-installer-operation.lock'), 'busy');
      await writeFile(join(source, '.skills-installer-lock-example.tmp'), 'partial lock');
      await writeFile(join(source, 'skills-lock.json'), 'foreign Vercel lock');
      await mkdir(join(source, '.agents', 'skills', 'vitest'), { recursive: true });
      await writeFile(join(source, '.agents', 'skills', 'vitest', 'SKILL.md'), 'installed skill');
      await mkdir(join(source, '.agents', '.skills-installer-work-example', 'previous'), {
        recursive: true,
      });
      await writeFile(
        join(source, '.agents', '.skills-installer-work-example', 'previous', 'SKILL.md'),
        'retained snapshot',
      );
      await symlink('.agents/skills', join(source, 'installed-alias'));
      if (fileSymlinks) await symlink('skills-installer-lock.json', join(source, 'lock-alias'));
      await mkdir(join(source, 'resources'), { recursive: true });
      await writeFile(join(source, 'resources', 'skills-installer-lock.json'), 'resource');
      await writeFile(
        join(source, 'resources', '.skills-installer-lock-resource.tmp'),
        'resource temp name',
      );
      const prepared = await prepareDirectory('.', options(fixture));
      try {
        expect(await readFile(join(prepared.directory, 'SKILL.md'), 'utf8')).toBe(skillText);
        expect(await readFile(join(prepared.directory, 'skills-lock.json'), 'utf8')).toBe(
          'foreign Vercel lock',
        );
        expect(
          await readFile(
            join(prepared.directory, 'resources', 'skills-installer-lock.json'),
            'utf8',
          ),
        ).toBe('resource');
        expect(
          await readFile(
            join(prepared.directory, 'resources', '.skills-installer-lock-resource.tmp'),
            'utf8',
          ),
        ).toBe('resource temp name');
        for (const path of [
          'skills-installer-lock.json',
          '.skills-installer-operation.lock',
          '.skills-installer-lock-example.tmp',
          '.agents/skills',
          '.agents/.skills-installer-work-example',
          'installed-alias',
          'lock-alias',
        ]) {
          await expect(lstat(join(prepared.directory, path))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
      } finally {
        await prepared.cleanup();
      }
    });
  });

  it('prepares the minimum skill with lexical identity and an idempotent cleanup', async () => {
    await withTestEnvironment(async (fixture) => {
      const source = join(fixture.roots.cwd, 'demo');
      await makeSkill(source);
      const sourceHash = await hashDirectory(source);
      const prepared = await prepareDirectory('./demo', options(fixture));
      expect(prepared).toMatchObject({
        name: 'demo',
        description: 'Demo skill',
        version: null,
        identity: { kind: 'directory', path: source },
      });
      expect(prepared.archiveHash).toBeUndefined();
      expect(await readFile(join(prepared.directory, 'SKILL.md'), 'utf8')).toBe(skillText);
      expect(prepared.contentHash).toBe(sourceHash);
      expect(await hashDirectory(prepared.directory)).toBe(prepared.contentHash);
      expect(await hashDirectory(source)).toBe(sourceHash);
      const paths = getStatePaths(fixture.roots, 'project');
      expect(
        portableSourcePath(
          prepared.identity.kind === 'directory' ? prepared.identity.path : '',
          paths,
        ),
      ).toBe('demo');
      await prepared.cleanup();
      await prepared.cleanup();
      await expect(lstat(dirname(prepared.directory))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(options(fixture).temporaryDirectory)).toEqual([]);
    });
  });

  it('preserves binary bytes, permissions, hidden files and empty/nested directories', async () => {
    await withTestEnvironment(async (fixture) => {
      const source = join(fixture.roots.cwd, 'demo');
      await makeSkill(source);
      await mkdir(join(source, 'scripts', 'empty'), { recursive: true });
      const script = '#!/bin/sh\ncat ../relative-input\n';
      await writeFile(join(source, 'scripts', 'run.sh'), script);
      await chmod(join(source, 'scripts', 'run.sh'), 0o751);
      const binary = Buffer.alloc(150_000, 0xff);
      binary[70_000] = 0;
      await writeFile(join(source, '.binary'), binary);
      // Generic names are resources, not a blanket ignore list.
      for (const name of ['tmp', 'backups', 'operation.lock', '.gitignore']) {
        await writeFile(join(source, name), name);
      }
      const original = await hashDirectory(source);
      const prepared = await prepareDirectory(source, options(fixture));
      try {
        expect(await readFile(join(prepared.directory, '.binary'))).toEqual(binary);
        expect(await readFile(join(prepared.directory, 'scripts', 'run.sh'), 'utf8')).toBe(script);
        if (process.platform !== 'win32')
          expect((await lstat(join(prepared.directory, 'scripts', 'run.sh'))).mode & 0o777).toBe(
            0o751,
          );
        expect(await readdir(join(prepared.directory, 'scripts', 'empty'))).toEqual([]);
        expect(prepared.contentHash).toBe(original);
        expect(await hashDirectory(source)).toBe(original);
      } finally {
        await prepared.cleanup();
      }
    });
  });

  // APFS does not allow creating these names; exercise byte names on Linux.
  it.skipIf(process.platform !== 'linux')(
    'preserves resource names that are not valid UTF-8',
    async () => {
      await withTestEnvironment(async (fixture) => {
        const source = join(fixture.roots.cwd, 'demo');
        await makeSkill(source);
        const suffix = Buffer.from([47, 0xff, 0xfe]);
        await writeFile(Buffer.concat([Buffer.from(source), suffix]), 'raw filename');
        const prepared = await prepareDirectory(source, {
          ...options(fixture),
          portableNames: false,
        });
        try {
          expect(
            await readFile(Buffer.concat([Buffer.from(prepared.directory), suffix]), 'utf8'),
          ).toBe('raw filename');
          expect(prepared.contentHash).toBe(await hashDirectory(source, { portableNames: false }));
        } finally {
          await prepared.cleanup();
        }
      });
    },
  );

  it.skipIf(!fileSymlinks)(
    'dereferences internal/external files and folders, nested links and repeated directory aliases',
    async () => {
      await withTestEnvironment(async (fixture) => {
        const source = join(fixture.roots.cwd, 'demo');
        const shared = join(fixture.roots.cwd, 'shared-scripts');
        await makeSkill(source);
        await mkdir(shared);
        await mkdir(join(source, 'resources'));
        await writeFile(join(source, 'resources', 'internal'), 'internal bytes');
        await writeFile(join(shared, 'run.sh'), '#!/bin/sh\ncat ../resources/internal\n');
        await chmod(join(shared, 'run.sh'), 0o711);
        await symlink('../shared-scripts', join(source, 'scripts'));
        await symlink('resources', join(source, 'resources-alias'));
        await symlink('resources', join(source, 'resources-alias-2'));
        await symlink('resources/internal', join(source, 'internal-file'));
        await symlink(join(shared, 'run.sh'), join(source, 'external-file'));
        await symlink('internal', join(source, 'resources', 'nested-link'));
        await symlink('external-file', join(source, 'chain'));
        const original = await hashDirectory(source);
        const prepared = await prepareDirectory(source, options(fixture));
        try {
          await assertNoLinks(prepared.directory);
          expect(
            await readFile(join(prepared.directory, 'resources-alias', 'nested-link'), 'utf8'),
          ).toBe('internal bytes');
          const copiedScript = await readFile(join(prepared.directory, 'scripts', 'run.sh'));
          if (process.platform !== 'win32')
            expect((await lstat(join(prepared.directory, 'scripts', 'run.sh'))).mode & 0o777).toBe(
              0o711,
            );
          expect(await readFile(join(prepared.directory, 'chain'))).toEqual(copiedScript);
          expect(await hashDirectory(source)).toBe(original);
          await writeFile(join(shared, 'run.sh'), 'changed externally');
          await rm(join(source, 'resources', 'internal'));
          expect(await readFile(join(prepared.directory, 'scripts', 'run.sh'))).toEqual(
            copiedScript,
          );
          expect(await hashDirectory(prepared.directory)).toBe(prepared.contentHash);
          // The only changes to the original tree are the explicit edits above.
          expect(original).not.toBe(await hashDirectory(source));
        } finally {
          await prepared.cleanup();
        }
      });
    },
  );

  it.skipIf(!fileSymlinks)(
    'accepts a root and SKILL.md symlink while keeping the original source identity',
    async () => {
      await withTestEnvironment(async (fixture) => {
        const target = join(fixture.roots.home, 'skill');
        await mkdir(target);
        await writeFile(join(fixture.roots.home, 'instructions'), skillText);
        await symlink('../instructions', join(target, 'SKILL.md'));
        await symlink(target, join(fixture.roots.cwd, 'alias'));
        const prepared = await prepareDirectory('./alias', options(fixture));
        try {
          expect(prepared.identity).toEqual({
            kind: 'directory',
            path: join(fixture.roots.cwd, 'alias'),
          });
          expect(await readFile(join(prepared.directory, 'SKILL.md'), 'utf8')).toBe(skillText);
          await assertNoLinks(prepared.directory);
        } finally {
          await prepared.cleanup();
        }
      });
    },
  );

  it.each(['self', 'file-chain', 'ancestor', 'external-back-edge', 'broken'])(
    'rejects %s links and removes partial output',
    async (kind) => {
      await withTestEnvironment(async (fixture) => {
        const source = join(fixture.roots.cwd, 'demo');
        await makeSkill(source);
        await writeFile(join(source, 'a-copied-first'), 'keep original');
        if (kind === 'self') await symlink('z-link', join(source, 'z-link'));
        if (kind === 'file-chain') {
          await symlink('z-second', join(source, 'z-link'), 'dir');
          await symlink('z-link', join(source, 'z-second'), 'dir');
        }
        if (kind === 'ancestor') {
          await mkdir(join(source, 'z-nested'));
          await symlink('..', join(source, 'z-nested', 'back'));
        }
        if (kind === 'external-back-edge') {
          await mkdir(join(fixture.roots.home, 'external'));
          await symlink(source, join(fixture.roots.home, 'external', 'back'));
          await symlink(join(fixture.roots.home, 'external'), join(source, 'z-link'));
        }
        if (kind === 'broken') await symlink('missing', join(source, 'z-link'));
        const original = await hashDirectory(source);
        await expect(prepareDirectory(source, options(fixture))).rejects.toMatchObject({
          code: kind === 'broken' ? 'PREPARATION_FAILED' : 'SOURCE_CYCLE',
        });
        expect(await hashDirectory(source)).toBe(original);
        expect(await readdir(options(fixture).temporaryDirectory)).toEqual([]);
      });
    },
  );

  it.skipIf(process.platform === 'win32').each(['direct', 'symlink'])(
    'rejects a %s special file without opening a FIFO',
    async (kind) => {
      await withTestEnvironment(async (fixture) => {
        const source = join(fixture.roots.cwd, 'demo');
        await makeSkill(source);
        const fifo = join(kind === 'direct' ? source : fixture.roots.home, 'fifo');
        execFileSync('mkfifo', [fifo], { env: fixture.env });
        if (kind === 'symlink') await symlink(fifo, join(source, 'fifo-link'));
        await expect(prepareDirectory(source, options(fixture))).rejects.toMatchObject({
          code: 'UNSUPPORTED_ENTRY',
        });
        expect((await lstat(fifo)).isFIFO()).toBe(true);
        expect(await readdir(options(fixture).temporaryDirectory)).toEqual([]);
      });
    },
  );

  it.each(['missing', 'file', 'no-skill', 'invalid-metadata', 'skill-is-directory'])(
    'rejects %s sources without leaving work files',
    async (kind) => {
      await withTestEnvironment(async (fixture) => {
        const source = join(fixture.roots.cwd, 'demo');
        if (kind === 'file') await writeFile(source, 'not a directory');
        if (kind === 'no-skill') await mkdir(source);
        if (kind === 'invalid-metadata') {
          await makeSkill(source);
          await writeFile(join(source, 'SKILL.md'), '---\nname: ../escape\n---\n');
        }
        if (kind === 'skill-is-directory')
          await mkdir(join(source, 'SKILL.md'), { recursive: true });
        const original = await hashDirectory(fixture.roots.cwd);
        await expect(prepareDirectory(source, options(fixture))).rejects.toBeInstanceOf(Error);
        expect(await hashDirectory(fixture.roots.cwd)).toBe(original);
        expect(await readdir(options(fixture).temporaryDirectory)).toEqual([]);
      });
    },
  );

  it('excludes CLI state at any depth and temporary data reached directly or through an alias', async () => {
    await withTestEnvironment(async (fixture) => {
      const source = fixture.roots.cwd;
      await makeSkill(source);
      const state = join(source, '.agents', 'skills');
      await makeSkill(join(state, 'existing'));
      await writeFile(join(source, 'skills-installer-lock.json'), 'existing lock');
      await mkdir(join(source, 'nested', '.agents'), { recursive: true });
      await writeFile(
        join(source, 'nested', '.agents', 'skills-installer-lock.json'),
        'global state',
      );
      const temporaryDirectory = join(source, 'work');
      await mkdir(temporaryDirectory);
      await writeFile(join(temporaryDirectory, 'unrelated-owned-work'), 'temporary');
      await symlink(state, join(source, 'state-alias'));
      await symlink(temporaryDirectory, join(source, 'work-alias'));
      await mkdir(join(source, 'work-sibling'));
      await writeFile(join(source, 'work-sibling', 'resource'), 'included');
      const before = await hashDirectory(source);
      const prepared = await prepareDirectory('.', {
        cwd: source,
        temporaryDirectory,
        excludedPaths: [join(source, 'nested', '.agents')],
      });
      try {
        expect((await readdir(prepared.directory)).sort()).toEqual([
          '.agents',
          'SKILL.md',
          'nested',
          'work-sibling',
        ]);
        expect(await readdir(join(prepared.directory, 'nested'))).toEqual([]);
        expect(await readFile(join(prepared.directory, 'work-sibling', 'resource'), 'utf8')).toBe(
          'included',
        );
        expect(await hashDirectory(prepared.directory)).toBe(prepared.contentHash);
      } finally {
        await prepared.cleanup();
      }
      expect(await hashDirectory(source)).toBe(before);
      expect(await readdir(temporaryDirectory)).toEqual(['unrelated-owned-work']);
    });
  });

  it('also excludes a temporary base whose parent is a symlink', async () => {
    await withTestEnvironment(async (fixture) => {
      await makeSkill(fixture.roots.cwd);
      await mkdir(join(fixture.roots.cwd, 'work'));
      await symlink(fixture.roots.cwd, join(fixture.roots.home, 'project-alias'));
      const prepared = await prepareDirectory('.', {
        cwd: fixture.roots.cwd,
        temporaryDirectory: join(fixture.roots.home, 'project-alias', 'work'),
      });
      try {
        expect(await readdir(prepared.directory)).toEqual(['SKILL.md']);
      } finally {
        await prepared.cleanup();
      }
    });
  });

  it('preserves resources and source folders merely named .agents', async () => {
    await withTestEnvironment(async (fixture) => {
      const source = join(fixture.roots.home, 'examples', '.agents');
      await makeSkill(source);
      await mkdir(join(source, 'resources', '.agents'), { recursive: true });
      await writeFile(
        join(source, 'resources', '.agents', 'skills-installer-lock.json'),
        'example resource',
      );
      const original = await hashDirectory(source);
      const prepared = await prepareDirectory(source, options(fixture));
      try {
        expect(
          await readFile(
            join(prepared.directory, 'resources', '.agents', 'skills-installer-lock.json'),
            'utf8',
          ),
        ).toBe('example resource');
        expect(prepared.contentHash).toBe(original);
        expect(await hashDirectory(source)).toBe(original);
      } finally {
        await prepared.cleanup();
      }
    });
  });

  it('excludes global state even when its root is a symlink to a differently named directory', async () => {
    await withTestEnvironment(async (fixture) => {
      await makeSkill(fixture.roots.cwd);
      const actualState = join(fixture.roots.cwd, 'actual-global-state');
      await mkdir(actualState);
      await writeFile(join(actualState, 'skills-installer-lock.json'), 'global state');
      const globalState = join(fixture.roots.home, '.agents');
      await symlink(actualState, globalState);
      const original = await hashDirectory(fixture.roots.cwd);
      const prepared = await prepareDirectory('.', {
        ...options(fixture),
        excludedPaths: [globalState],
      });
      try {
        expect(await readdir(prepared.directory)).toEqual(['SKILL.md']);
      } finally {
        await prepared.cleanup();
      }
      expect(await hashDirectory(fixture.roots.cwd)).toBe(original);
    });
  });

  it('does not follow a cyclic link at an excluded storage root', async () => {
    await withTestEnvironment(async (fixture) => {
      await makeSkill(fixture.roots.cwd);
      await mkdir(join(fixture.roots.cwd, '.agents'));
      await symlink('skills', join(fixture.roots.cwd, '.agents', 'skills'));
      const prepared = await prepareDirectory('.', options(fixture));
      try {
        expect(await readdir(prepared.directory)).toEqual(['.agents', 'SKILL.md']);
      } finally {
        await prepared.cleanup();
      }
      expect((await lstat(join(fixture.roots.cwd, '.agents', 'skills'))).isSymbolicLink()).toBe(
        true,
      );
    });
  });

  it.each(['state', 'temporary'])('rejects a source inside its own %s data', async (kind) => {
    await withTestEnvironment(async (fixture) => {
      const source =
        kind === 'state'
          ? join(fixture.roots.cwd, '.agents', 'skills', 'demo')
          : join(options(fixture).temporaryDirectory, 'demo');
      await makeSkill(source);
      const original = await hashDirectory(source);
      await expect(prepareDirectory(source, options(fixture))).rejects.toMatchObject({
        code: 'INVALID_SOURCE',
      });
      expect(await hashDirectory(source)).toBe(original);
    });
  });

  it.each(['cwd', 'temporaryDirectory'])('requires an absolute %s', async (field) => {
    await withTestEnvironment(async (fixture) => {
      await expect(
        prepareDirectory('demo', { ...options(fixture), [field]: '.' }),
      ).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
      expect(await readdir(options(fixture).temporaryDirectory)).toEqual([]);
    });
  });

  it('does not create a missing temporary base inside the source', async () => {
    await withTestEnvironment(async (fixture) => {
      await makeSkill(fixture.roots.cwd);
      const original = await hashDirectory(fixture.roots.cwd);
      await expect(
        prepareDirectory('.', {
          cwd: fixture.roots.cwd,
          temporaryDirectory: join(fixture.roots.cwd, 'new', 'work'),
        }),
      ).rejects.toMatchObject({ code: 'PREPARATION_FAILED' });
      expect(await hashDirectory(fixture.roots.cwd)).toBe(original);
      expect(await readdir(fixture.roots.cwd)).toEqual(['SKILL.md']);
    });
  });

  it('keeps SKILL.md bytes including BOM, CRLF and binary bytes in the body', async () => {
    await withTestEnvironment(async (fixture) => {
      const source = join(fixture.roots.cwd, 'demo');
      await mkdir(source);
      const bytes = Buffer.concat([
        Buffer.from(
          '\uFEFF---\r\nname: demo\r\ndescription: Demo skill\r\n---\r\n[link](../unchanged)\r\n',
        ),
        Buffer.from([0xff, 0x00, 0xfe]),
      ]);
      await writeFile(join(source, 'SKILL.md'), bytes);
      const prepared = await prepareDirectory(source, options(fixture));
      try {
        expect(await readFile(join(prepared.directory, 'SKILL.md'))).toEqual(bytes);
        expect(prepared.contentHash).toBe(await hashDirectory(source));
      } finally {
        await prepared.cleanup();
      }
    });
  });

  it('cleans up when hashing the prepared snapshot fails', async () => {
    await withTestEnvironment(async (fixture) => {
      const source = join(fixture.roots.cwd, 'demo');
      await makeSkill(source);
      const original = await hashDirectory(source);
      await expect(
        prepareDirectory(source, {
          ...options(fixture),
          fileSystem: {
            ...directorySourceFileSystem,
            readFile: async (path: string) => {
              vi.spyOn(hashing, 'hashDirectory').mockRejectedValueOnce(
                new Error('snapshot hash failure'),
              );
              return readFile(path, 'utf8');
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'PREPARATION_FAILED' });
      expect(await hashDirectory(source)).toBe(original);
      expect(await readdir(options(fixture).temporaryDirectory)).toEqual([]);
    });
  });

  it.for([
    'directory-read',
    'file-read',
    'file-write',
    'file-stat',
    'file-chmod',
    'metadata-read',
    'destination-escape',
  ])(
    'cleans up after injected %s failure and preserves the source and existing state',
    async (failure, context) => {
      if (failure === 'file-chmod' && process.platform === 'win32')
        context.skip('POSIX chmod; portable write/stat failures проверяются рядом.');
      await withTestEnvironment(async (fixture) => {
        const source = join(fixture.roots.cwd, 'demo');
        await makeSkill(source);
        const resource = join(source, 'z-resource');
        await writeFile(resource, Buffer.alloc(150_000, 0x42));
        const state = join(fixture.roots.cwd, '.agents');
        await makeSkill(join(state, 'skills', 'existing'));
        await writeFile(join(fixture.roots.cwd, 'skills-installer-lock.json'), 'existing lock');
        const original = await hashDirectory(fixture.roots.cwd);
        const injected = Object.assign(new Error(`injected ${failure}`), { code: 'EACCES' });
        let calls = 0;
        let output: string | undefined;
        const fileSystem = {
          ...directorySourceFileSystem,
          readdir: async (path: Buffer) => {
            if (failure === 'directory-read') {
              calls++;
              throw injected;
            }
            if (failure === 'destination-escape') {
              calls++;
              return [Buffer.from('../escape')];
            }
            return directorySourceFileSystem.readdir(path);
          },
          readFile:
            failure === 'metadata-read'
              ? vi.fn(async () => {
                  calls++;
                  throw injected;
                })
              : readFile,
          open: async (...args: Parameters<typeof open>) => {
            const handle = await open(...args);
            const [path, flags] = args;
            if (failure === 'file-read' && String(path) === resource && flags !== 'wx') {
              vi.spyOn(handle, 'read').mockImplementation(async () => {
                calls++;
                throw injected;
              });
            }
            if (failure === 'file-stat' && String(path) === resource && flags !== 'wx') {
              vi.spyOn(handle, 'stat').mockImplementation(async () => {
                calls++;
                throw injected;
              });
            }
            if (
              failure === 'file-write' &&
              flags === 'wx' &&
              basename(String(path)) === 'z-resource'
            ) {
              output = String(path);
              // Leave a partial destination to verify rollback after a real write.
              await handle.write(Buffer.from('partial'));
              vi.spyOn(handle, 'write').mockImplementation(async () => {
                calls++;
                throw injected;
              });
            }
            if (
              failure === 'file-chmod' &&
              flags === 'wx' &&
              basename(String(path)) === 'z-resource'
            ) {
              vi.spyOn(handle, 'chmod').mockImplementation(async () => {
                calls++;
                throw injected;
              });
            }
            return handle;
          },
        };
        await expect(
          prepareDirectory(source, { ...options(fixture), fileSystem }),
        ).rejects.toBeInstanceOf(Error);
        if (failure !== 'metadata-read') expect(calls).toBeGreaterThan(0);
        expect(await hashDirectory(fixture.roots.cwd)).toBe(original);
        expect(await readdir(options(fixture).temporaryDirectory)).toEqual([]);
        if (output) await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
      });
    },
  );

  it('reports cleanup failure with both causes and an explicit workspace path', async () => {
    await withTestEnvironment(async (fixture) => {
      const source = join(fixture.roots.cwd, 'demo');
      await makeSkill(source);
      const readError = new Error('read failed');
      const cleanupError = new Error('cleanup failed');
      await expect(
        prepareDirectory(source, {
          ...options(fixture),
          fileSystem: {
            ...directorySourceFileSystem,
            readFile: vi.fn(async () => {
              throw readError;
            }),
            rm: vi.fn<typeof rm>().mockRejectedValue(cleanupError),
          },
        }),
      ).rejects.toMatchObject({
        code: 'PREPARATION_FAILED',
        message: expect.stringContaining('удаление временных файлов завершились ошибкой'),
        cause: expect.objectContaining({
          errors: [expect.objectContaining({ cause: readError }), cleanupError],
        }),
      });
      expect(await readFile(join(source, 'SKILL.md'), 'utf8')).toBe(skillText);
    });
  });

  it.skipIf(!fileSymlinks)('rejects a file replaced by a symlink just before open', async () => {
    await withTestEnvironment(async (fixture) => {
      const source = join(fixture.roots.cwd, 'demo');
      await makeSkill(source);
      const resource = join(source, 'resource');
      await writeFile(resource, 'original');
      const target = join(fixture.roots.home, 'outside');
      await writeFile(target, 'outside data');
      let replaced = false;
      const fileSystem = {
        ...directorySourceFileSystem,
        open: async (...args: Parameters<typeof open>) => {
          if (String(args[0]) === (await realpath(resource)) && !replaced) {
            replaced = true;
            await rm(resource);
            await symlink(target, resource);
          }
          return open(...args);
        },
      };
      await expect(
        prepareDirectory(source, { ...options(fixture), fileSystem }),
      ).rejects.toBeInstanceOf(Error);
      expect(replaced).toBe(true);
      expect(await readFile(target, 'utf8')).toBe('outside data');
      expect(await readdir(options(fixture).temporaryDirectory)).toEqual([]);
    });
  });
});
