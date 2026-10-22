import { mkdir, open, readFile, readdir, type FileHandle, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { prepareArchive } from '@/sources/archive';
import { prepareDirectory } from '@/sources/directory';
import {
  archiveSourceFileSystem,
  directorySourceFileSystem,
  OWNED_WORKSPACE_CLEANUP,
  type ArchiveSourceFileSystem,
} from '@/sources/filesystem';
import { archiveBytes, skillText } from '../helpers/archive.ts';
import { withTestEnvironment, type TestEnvironment } from '../helpers/test-environment.ts';

/** Создаёт настоящий источник внутри fixture; подменяет только I/O подготовки, не владея её cleanup. */
async function makeSource(f: TestEnvironment, kind: 'directory' | 'archive') {
  const path = join(f.roots.cwd, kind === 'archive' ? 'demo.tgz' : 'demo');
  const bytes =
    kind === 'archive'
      ? archiveBytes([{ path: 'SKILL.md', contents: skillText }])
      : Buffer.from(skillText);
  if (kind === 'directory') await mkdir(path);
  const file = kind === 'archive' ? path : join(path, 'SKILL.md');
  await writeFile(file, bytes);
  return {
    file,
    bytes,
    prepare: (
      io: Partial<Pick<ArchiveSourceFileSystem, 'open' | 'rm'>> = {},
      signal?: AbortSignal,
    ) => {
      const options = { cwd: f.roots.cwd, temporaryDirectory: f.env.TMPDIR!, signal };
      return kind === 'archive'
        ? prepareArchive(path, {
            ...options,
            fileSystem: { ...archiveSourceFileSystem, ...io },
          })
        : prepareDirectory(path, {
            ...options,
            fileSystem: { ...directorySourceFileSystem, ...io },
          });
    },
  };
}

describe.each(['directory', 'archive'] as const)('%s file operations', (kind) => {
  it.each(['zero-write'] as readonly ('zero-write' | 'abort-short-write')[])(
    'stops after %s, closes handles before cleanup and keeps source bytes',
    async (failure) =>
      withTestEnvironment(async (f) => {
        const source = await makeSource(f, kind);
        const handles: FileHandle[] = [];
        const controller = new AbortController();
        const reason = new Error('cancel during write');
        let writes = 0;
        const remove = vi.fn<ArchiveSourceFileSystem['rm']>(async (...args) => {
          expect(handles.every((handle) => handle.fd === -1)).toBe(true);
          await archiveSourceFileSystem.rm(...args);
        });
        const result = source.prepare(
          {
            rm: remove,
            open: async (...args) => {
              const handle = await open(...args);
              handles.push(handle);
              if (args[1] === 'wx') {
                const write = handle.write.bind(handle);
                vi.spyOn(handle, 'write').mockImplementation((async (
                  buffer: Buffer,
                  offset: number,
                  length: number,
                  position: number | null,
                ) => {
                  writes++;
                  if (failure === 'zero-write') return { buffer, bytesWritten: 0 };
                  const result = await write(buffer, offset, Math.min(length, 1), position);
                  controller.abort(reason);
                  return result;
                }) as typeof handle.write);
              }
              return handle;
            },
          },
          controller.signal,
        );
        if (failure === 'zero-write')
          await expect(result).rejects.toMatchObject({
            code: 'PREPARATION_FAILED',
            cause: expect.objectContaining({ message: expect.stringContaining('запись') }),
          });
        else await expect(result).rejects.toBe(reason);
        expect(writes).toBe(1);
        expect(handles).toHaveLength(2);
        expect(handles.every((handle) => handle.fd === -1)).toBe(true);
        expect(remove).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(`skills-installer-${kind === 'archive' ? 'archive' : 'source'}-`),
          OWNED_WORKSPACE_CLEANUP,
        );
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
        expect(await readFile(source.file)).toEqual(source.bytes);
      }),
  );

  it.each([-1n, 1n])('rejects a source size differing from fstat by %s', async (difference) =>
    withTestEnvironment(async (f) => {
      const source = await makeSource(f, kind);
      const handles: FileHandle[] = [];
      await expect(
        source.prepare({
          open: async (...args) => {
            const handle = await open(...args);
            handles.push(handle);
            if (args[1] !== 'wx') {
              const stats = await handle.stat({ bigint: true });
              stats.size += difference;
              vi.spyOn(handle, 'stat').mockResolvedValue(stats);
            }
            return handle;
          },
        }),
      ).rejects.toMatchObject({
        code: 'PREPARATION_FAILED',
        cause: expect.objectContaining({ message: expect.stringContaining('Размер') }),
      });
      expect(handles.length).toBeGreaterThan(0);
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
      expect(await readFile(source.file)).toEqual(source.bytes);
    }),
  );
});

describe('source failure diagnostics', () => {
  it.each(['read'] as readonly ('read' | 'write' | 'abort')[])(
    'retains %s, both close errors and cleanup failure in closing order',
    async (failure) =>
      withTestEnvironment(async (f) => {
        const source = await makeSource(f, 'directory');
        const controller = new AbortController();
        const operationError = new Error(failure);
        const outputError = new Error('close output');
        const inputError = new Error('close input');
        const cleanupError = new Error('cleanup');
        const events: string[] = [];
        const handles: FileHandle[] = [];
        await expect(
          source.prepare(
            {
              open: async (...args) => {
                const handle = await open(...args);
                handles.push(handle);
                const output = args[1] === 'wx';
                const close = handle.close.bind(handle);
                vi.spyOn(handle, 'close').mockImplementation(async () => {
                  await close();
                  events.push(output ? 'output' : 'input');
                  throw output ? outputError : inputError;
                });
                if (output && failure === 'write')
                  vi.spyOn(handle, 'write').mockRejectedValue(operationError);
                if (!output && failure === 'read')
                  vi.spyOn(handle, 'read').mockRejectedValue(operationError);
                if (!output && failure === 'abort') {
                  const read = handle.read.bind(handle);
                  vi.spyOn(handle, 'read').mockImplementation(async (...args) => {
                    const result = await read(...args);
                    controller.abort(operationError);
                    return result;
                  });
                }
                return handle;
              },
              rm: async () => {
                expect(handles.every((handle) => handle.fd === -1)).toBe(true);
                events.push('cleanup');
                throw cleanupError;
              },
            },
            controller.signal,
          ),
        ).rejects.toMatchObject({
          code: 'PREPARATION_FAILED',
          message: expect.stringContaining('skills-installer-source-'),
          cause: expect.objectContaining({
            errors: [
              expect.objectContaining({
                code: 'PREPARATION_FAILED',
                cause: expect.objectContaining({
                  errors: [
                    expect.objectContaining({ errors: [operationError, outputError] }),
                    inputError,
                  ],
                }),
              }),
              cleanupError,
            ],
          }),
        });
        expect(events).toEqual(['output', 'input', 'cleanup']);
        expect(handles).toHaveLength(2);
        expect(await readdir(f.env.TMPDIR!)).toHaveLength(1);
        expect(await readFile(source.file)).toEqual(source.bytes);
      }),
  );

  it('closes the input and preserves both errors when opening the output fails', async () =>
    withTestEnvironment(async (f) => {
      const source = await makeSource(f, 'directory');
      const openError = new Error('open output');
      const closeError = new Error('close input');
      let input: FileHandle | undefined;
      await expect(
        source.prepare({
          open: async (...args) => {
            if (args[1] === 'wx') throw openError;
            const handle = await open(...args);
            input = handle;
            const close = handle.close.bind(handle);
            vi.spyOn(handle, 'close').mockImplementation(async () => {
              await close();
              throw closeError;
            });
            return handle;
          },
        }),
      ).rejects.toMatchObject({
        code: 'PREPARATION_FAILED',
        cause: expect.objectContaining({ errors: [openError, closeError] }),
      });
      expect(input?.fd).toBe(-1);
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
    }));

  it.each(['read', 'write'] as const)(
    'preserves archive %s and close errors, removing workspace only after close',
    async (stage) =>
      withTestEnvironment(async (f) => {
        const source = await makeSource(f, 'archive');
        const failure = new Error(stage);
        const closeError = new Error('close');
        const handles: FileHandle[] = [];
        const remove = vi.fn<ArchiveSourceFileSystem['rm']>(async (...args) => {
          expect(handles.every((handle) => handle.fd === -1)).toBe(true);
          await archiveSourceFileSystem.rm(...args);
        });
        await expect(
          source.prepare({
            rm: remove,
            open: async (...args) => {
              const handle = await open(...args);
              handles.push(handle);
              if ((args[1] === 'wx') === (stage === 'write')) {
                vi.spyOn(handle, stage).mockRejectedValue(failure);
                const close = handle.close.bind(handle);
                vi.spyOn(handle, 'close').mockImplementation(async () => {
                  await close();
                  throw closeError;
                });
              }
              return handle;
            },
          }),
        ).rejects.toMatchObject({
          code: 'PREPARATION_FAILED',
          cause: expect.objectContaining({ errors: [failure, closeError] }),
        });
        expect(handles.every((handle) => handle.fd === -1)).toBe(true);
        expect(remove).toHaveBeenCalledTimes(stage === 'write' ? 1 : 0);
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
        expect(await readFile(source.file)).toEqual(source.bytes);
      }),
  );
});
