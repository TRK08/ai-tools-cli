import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Installer } from '@/installer/installer';
import { withTestEnvironment } from '../helpers/test-environment.ts';
import { versionRegistry } from '../helpers/versions.ts';
import { archiveBytes, skillText } from '../helpers/archive.ts';

it.each(['metadata', 'preparation'] as const)(
  'keeps both prior copies, lock and releases resources after %s failure',
  async (stage) => {
    const backend = versionRegistry();
    await withTestEnvironment(async (f) => {
      const local = join(f.roots.cwd, 'source');
      await mkdir(local);
      await writeFile(join(local, 'SKILL.md'), skillText);
      const archive = join(f.roots.cwd, 'source.tgz');
      await writeFile(archive, archiveBytes([{ path: 'SKILL.md', contents: skillText }]));
      const input = stage === 'metadata' ? 'demo' : archive;
      const installer = new Installer({ ...f, http: backend.http }, { registry: backend.url });
      await installer.add(input, false, ['codex', 'claude-code']);
      const paths = [
        'skills-installer-lock.json',
        '.agents/skills/demo/SKILL.md',
        '.claude/skills/demo/SKILL.md',
      ];
      const before = await Promise.all(paths.map((path) => readFile(join(f.roots.cwd, path))));
      if (stage === 'metadata') backend.failures.add('demo');
      else await writeFile(archive, 'corrupt gzip');
      await expect(installer.add(input, true, ['codex', 'claude-code'])).rejects.toBeInstanceOf(
        Error,
      );
      expect(await Promise.all(paths.map((path) => readFile(join(f.roots.cwd, path))))).toEqual(
        before,
      );
      expect(
        (await readdir(join(f.roots.cwd, '.agents'))).filter((n) =>
          n.includes('.skills-installer-work-'),
        ),
      ).toEqual([]);
      expect(
        (await readdir(f.roots.cwd)).filter((n) => n === '.skills-installer-operation.lock'),
      ).toEqual([]);
    });
  },
);
