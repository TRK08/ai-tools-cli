import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CatalogSkill } from '@/registry';
import { prepareRegistrySource } from '@/sources';
import { hashDirectory } from '@/state';
import { binaryResource, registrySkill, type ZipEntry } from '../helpers/registry.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

const instruction: ZipEntry = {
  path: 'SKILL.md',
  contents: Buffer.from('---\nname: docs-check\ndescription: Test skill\n---\n'),
};
const file = (path: string): ZipEntry => ({ path, contents: Buffer.from('resource') });

const fixture = (options: Parameters<typeof registrySkill>[3] = {}) => {
  const { bytes, wire } = registrySkill('docs', 'check', '1.0.0', options);
  const skill: CatalogSkill = {
    packageSlug: wire.packageSlug,
    name: wire.name,
    version: wire.version,
    title: wire.metadata.title,
    description: wire.metadata.shortDescription,
    installName: wire.spec.installName,
    size: wire.spec.archive.size,
    sha256: wire.spec.archive.sha256,
  };
  return { bytes, skill };
};

/** Проверяет конкретную причину отказа до mkdir и отсутствие записи вне назначения. */
async function rejectsBeforeWriting(
  archive: ReturnType<typeof fixture>,
  error: { message?: RegExp; cause?: { code: string; message: RegExp } },
): Promise<void> {
  await withTestEnvironment(async ({ roots, temporaryRoot }) => {
    const before = await hashDirectory(temporaryRoot);
    const dir = join(roots.cwd, 'prepared');
    await expect(prepareRegistrySource(archive.bytes, archive.skill, dir)).rejects.toMatchObject({
      code: 'INVALID_ARCHIVE',
      ...error,
    });
    await expect(access(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await hashDirectory(temporaryRoot)).toBe(before);
  });
}

/** Дополняет распакованный объём descriptor до точного размера, сохраняя корректные SHA-256. */
function expandedFixture(size: number) {
  const descriptorSize = 1024;
  return fixture({
    files: [
      instruction,
      {
        path: 'payload.bin',
        contents: Buffer.alloc(size - descriptorSize - instruction.contents.length),
        method: 8,
      },
    ],
    descriptorSize,
  });
}

describe('component ZIP', () => {
  it('preserves bytes, executable scripts and component.json', async () => {
    const { bytes, skill } = fixture();
    await withTestEnvironment(async ({ roots }) => {
      const dir = join(roots.cwd, 'prepared');
      const hash = await prepareRegistrySource(bytes, skill, dir);
      expect(hash).toBe(await hashDirectory(dir));
      expect(await readFile(join(dir, 'references/файл.bin'))).toEqual(binaryResource);
      expect(JSON.parse(await readFile(join(dir, 'component.json'), 'utf8'))).toMatchObject({
        installName: 'docs-check',
        version: '1.0.0',
      });
      if (process.platform !== 'win32')
        expect((await stat(join(dir, 'scripts/run.sh'))).mode & 0o111).toBe(0o111);
    });
  });

  it.each(['../escape', '/absolute', 'C:/drive', 'nested\\escape', 'CON.txt'])(
    'rejects unsafe path %j even when descriptor declares it',
    async (path) => {
      await rejectsBeforeWriting(fixture({ files: [instruction, file(path)] }), {
        cause: { code: 'INVALID_PATH', message: /Непереносимое имя/ },
      });
    },
  );

  it.each([
    ['case', 'one.txt', 'ONE.txt'],
    ['NFC', 'references/файл.bin', 'references/файл.bin'],
    ['file before directory', 'references', 'references/file'],
    ['directory before file', 'references/file', 'references'],
  ])('rejects %s collisions declared in descriptor', async (_label, first, second) => {
    await rejectsBeforeWriting(fixture({ files: [instruction, file(first!), file(second!)] }), {
      message: /Повторяющийся или пересекающийся путь/,
    });
  });

  it('rejects a repeated ZIP entry with a consistent unique descriptor', async () => {
    await rejectsBeforeWriting(fixture({ mutateEntries: (entries) => entries.push(entries[0]!) }), {
      message: /Повторяющийся или пересекающийся путь/,
    });
  });

  it('rejects an unlisted file separately from path validation', async () => {
    await rejectsBeforeWriting(fixture({ extra: [file('extra')] }), {
      message: /состав component.json не совпадает/,
    });
  });

  it.each(['package', 'kind', 'name', 'version', 'installName', 'files', 'schemaVersion'])(
    'validates manifest %s before writing files',
    async (key) => {
      await rejectsBeforeWriting(
        fixture({
          mutateManifest: (manifest) => {
            manifest[key] = 'other';
          },
        }),
        {
          message: /component.json/,
        },
      );
    },
  );

  it.each(['sha256', 'size', 'mode', 'path'] as const)(
    'rejects descriptor file %s mismatch',
    async (key) => {
      await rejectsBeforeWriting(
        fixture({
          mutateManifest: (manifest) => {
            const [first] = manifest.files as Record<string, unknown>[];
            first![key] = { sha256: 'a'.repeat(64), size: 0, mode: 0, path: 'missing' }[key];
          },
        }),
        { message: /Файл .* не совпадает с component.json/ },
      );
    },
  );

  it.each([0o120777, 0o040755, 0o010644, 0o060644])('rejects non-regular mode %i', async (mode) => {
    await rejectsBeforeWriting(fixture({ files: [instruction, { ...file('object'), mode }] }), {
      message: /неподдерживаемый объект/,
    });
  });

  it.each(['name', 'method'] as const)('rejects mismatched local header %s', async (field) => {
    await rejectsBeforeWriting(
      fixture({
        mutateZip: (bytes) => {
          if (field === 'name') bytes.write('OTHER.md', 30);
          else bytes.writeUInt16LE(0, 8);
        },
      }),
      { message: /Заголовки файла ZIP не совпадают/ },
    );
  });

  const limits = [
    {
      label: 'entry count including descriptor',
      max: 1000,
      make: (count: number) =>
        fixture({
          files: [instruction, ...Array.from({ length: count - 2 }, (_, i) => file(`files/${i}`))],
        }),
      error: /Слишком много файлов/,
    },
    {
      label: 'expanded bytes including descriptor',
      max: 25 * 1024 * 1024,
      make: expandedFixture,
      error: /Размер содержимого ZIP/,
    },
    {
      label: 'descriptor bytes',
      max: 1024 * 1024,
      make: (descriptorSize: number) => fixture({ descriptorSize }),
      error: /Размер содержимого ZIP/,
    },
    {
      label: 'path depth',
      max: 12,
      make: (depth: number) =>
        fixture({
          files: [instruction, file([...Array<string>(depth - 1).fill('dir'), 'file'].join('/'))],
        }),
      error: /Слишком длинный путь/,
    },
    {
      label: 'UTF-8 path bytes',
      max: 512,
      make: (length: number) =>
        fixture({
          files: [
            instruction,
            file(`${'я'.repeat(100)}/${'b'.repeat(200)}/${'c'.repeat(length - 402)}`),
          ],
        }),
      error: /Слишком длинный путь/,
    },
  ];
  for (const { label, max, make, error } of limits) {
    it(`accepts the exact ${label} limit`, async () => {
      const { bytes, skill } = make(max);
      await withTestEnvironment(async ({ roots }) => {
        const dir = join(roots.cwd, 'prepared');
        expect(await prepareRegistrySource(bytes, skill, dir)).toBe(await hashDirectory(dir));
        expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toContain('docs-check');
      });
    });
    it(`rejects one above the ${label} limit before writing`, async () => {
      await rejectsBeforeWriting(make(max + 1), { message: error });
    });
  }
});
