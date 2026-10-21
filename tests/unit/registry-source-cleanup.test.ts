import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { readFile, readdir, rm } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { RegistryClient } from '../../src/registry/client.ts';
import { RegistryError } from '../../src/registry/errors.ts';
import { OWNED_WORKSPACE_CLEANUP } from '../../src/sources/filesystem.ts';
import { prepareRegistrySource } from '../../src/sources/registry.ts';
import { archiveBytes, skillText } from '../helpers/archive.ts';
import { artifact } from '../helpers/registry.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, rm: vi.fn(fs.rm) };
});

/** Передаёт готовый артефакт и подменённый HTTP; registry cleanup проверяется на настоящем workspace. */
function registrySource(text = skillText) {
  const bytes = archiveBytes([{ path: 'SKILL.md', contents: text }]);
  return {
    bytes,
    client: new RegistryClient(
      'https://registry.test',
      async () => new Response(new Uint8Array(bytes)),
    ),
    selected: artifact('https://registry.test/download', {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    }),
  };
}

describe('registry source workspace ownership', () => {
  it('retains the domain error, cleanup failure and remaining download workspace', async () =>
    withTestEnvironment(async (f) => {
      const source = registrySource(skillText.replace('name: demo', 'name: other'));
      const cleanupError = new Error('download cleanup failed');
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let workspace = '';
      vi.mocked(rm).mockImplementation(async (path, options) => {
        if (basename(String(path)).startsWith('skills-installer-download-')) {
          workspace = String(path);
          expect(dirname(workspace)).toBe(f.env.TMPDIR);
          expect(options).toEqual(OWNED_WORKSPACE_CLEANUP);
          throw cleanupError;
        }
        await actual.rm(path, options);
      });
      try {
        const error = await prepareRegistrySource(
          { slug: 'demo' },
          source.client,
          { cwd: f.roots.cwd, temporaryDirectory: f.env.TMPDIR! },
          undefined,
          source.selected,
        ).catch((error: unknown) => error);
        expect(workspace).not.toBe('');
        expect(error).toMatchObject({
          name: 'Error',
          message: `Подготовка из реестра и удаление временных файлов завершились ошибкой: ${workspace}.`,
          cause: expect.objectContaining({
            errors: [
              expect.objectContaining({
                name: 'RegistryError',
                code: 'ARTIFACT_MISMATCH',
                message: 'Имя в SKILL.md не соответствует запрошенному slug реестра.',
              }),
              cleanupError,
            ],
          }),
        });
        expect((error as Error).cause).toBeInstanceOf(AggregateError);
        expect(((error as Error).cause as AggregateError).errors[0]).toBeInstanceOf(RegistryError);
        expect(await readFile(join(workspace, 'artifact.tar.gz'))).toEqual(source.bytes);
        expect(await readdir(f.env.TMPDIR!)).toEqual([basename(workspace)]);
      } finally {
        vi.mocked(rm).mockImplementation(actual.rm);
      }
    }));

  it('leaves successful cleanup to the consumer and permits retry after its failure', async () =>
    withTestEnvironment(async (f) => {
      const source = registrySource();
      const prepared = await prepareRegistrySource(
        { slug: 'demo' },
        source.client,
        { cwd: f.roots.cwd, temporaryDirectory: f.env.TMPDIR! },
        undefined,
        source.selected,
      );
      const workspace = dirname(dirname(prepared.directory));
      expect(dirname(workspace)).toBe(f.env.TMPDIR);
      expect(await readFile(join(prepared.directory, 'SKILL.md'), 'utf8')).toBe(skillText);
      const cleanupError = new Error('consumer cleanup failed');
      vi.mocked(rm).mockClear().mockRejectedValueOnce(cleanupError);
      await expect(prepared.cleanup()).rejects.toBe(cleanupError);
      expect(rm).toHaveBeenCalledExactlyOnceWith(workspace, OWNED_WORKSPACE_CLEANUP);
      expect(await readFile(join(workspace, 'artifact.tar.gz'))).toEqual(source.bytes);
      await prepared.cleanup();
      await prepared.cleanup();
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
    }));
});
