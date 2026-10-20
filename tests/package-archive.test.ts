import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { list as listTar } from 'tar';
import { expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };
import { withIsolatedRuntime } from '../scripts/isolated-runtime.ts';
import { packageRunner } from '../scripts/package-runner.ts';
import { preparePackageArchive } from '../scripts/package-archive.ts';

interface PackResult {
  filename: string;
  files: { path: string; mode: number }[];
}

it('packs the declared bin as executable when the source has no executable bits', async () => {
  await withIsolatedRuntime(async (fixture) => {
    const binPath = manifest.bin['skills-installer'].replace(/^\.\//, '');
    const bin = join(fixture.roots.cwd, binPath);
    await mkdir(dirname(bin), { recursive: true });
    const binBytes = Buffer.from('#!/usr/bin/env node\nconsole.log("package regression");\n');
    await writeFile(bin, binBytes);
    await chmod(bin, 0o644);
    await mkdir(join(fixture.roots.cwd, 'dist'), { recursive: true });
    const resourceBytes = Buffer.from([0, 255, 128, 13, 10]);
    await writeFile(join(fixture.roots.cwd, 'dist', 'resource.txt'), resourceBytes);
    await chmod(join(fixture.roots.cwd, 'dist', 'resource.txt'), 0o644);
    await writeFile(
      join(fixture.roots.cwd, 'package.json'),
      JSON.stringify({
        name: 'package-bin-regression',
        version: '1.0.0',
        type: 'module',
        bin: manifest.bin,
        files: manifest.files,
      }),
    );
    expect((await lstat(bin)).mode & 0o111).toBe(0);
    const runner = packageRunner(fixture.env, process.env.npm_execpath);
    const prepared = await preparePackageArchive(
      runner,
      fixture.roots.cwd,
      fixture.env.TMPDIR!,
      binPath,
    );
    const preview = JSON.parse(
      runner.npm(['pack', prepared, '--dry-run', '--json', '--ignore-scripts'], fixture.roots.cwd),
    )[0] as PackResult;
    expect.soft(preview.files.find((file) => file.path === binPath)!.mode & 0o111).toBe(0o111);
    const packed = JSON.parse(
      runner.npm(
        [
          'pack',
          prepared,
          '--json',
          '--ignore-scripts',
          '--pack-destination',
          fixture.temporaryRoot,
        ],
        fixture.roots.cwd,
      ),
    )[0] as PackResult;
    expect.soft(packed.files.find((file) => file.path === binPath)!.mode & 0o111).toBe(0o111);
    const modes = new Map<string, number>();
    const contents = new Map<string, Buffer>();
    await listTar({
      file: join(fixture.temporaryRoot, packed.filename),
      onReadEntry(entry) {
        modes.set(entry.path, entry.mode ?? 0);
        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer) => chunks.push(chunk));
        entry.on('end', () => contents.set(entry.path, Buffer.concat(chunks)));
      },
    });
    expect.soft(modes.get(`package/${binPath}`)! & 0o111).toBe(0o111);
    expect(modes.has('package/dist/resource.txt')).toBe(true);
    expect(modes.get('package/dist/resource.txt')! & 0o111).toBe(0);
    expect(contents.get(`package/${binPath}`)).toEqual(binBytes);
    expect(contents.get('package/dist/resource.txt')).toEqual(resourceBytes);
    expect((await lstat(bin)).mode & 0o111).toBe(0);
  });
});
