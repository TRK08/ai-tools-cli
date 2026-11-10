import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { readRegistryConfig, resolveRegistryUrl, writeRegistryConfig } from '@/config';
import { getRegistryUrl } from '@/registry';
import { runCliSync } from '../helpers/cli.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';
import { terminal } from '../helpers/terminal.ts';
import { executeCli } from '@/cli/run';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
beforeEach(() => {
  vi.mocked(open).mockImplementation(actualFs.open);
  vi.mocked(rename).mockImplementation(actualFs.rename);
});

it('persists, gets and unsets registry between processes without HTTP', async () => {
  await withTestEnvironment(async (f) => {
    const args = ['config', 'set', 'registry', 'https://REGISTRY.test/proxy///'];
    expect(runCliSync(f, args).status).toBe(0);
    expect(runCliSync(f, ['config', 'get', 'registry']).stdout.trim()).toBe(
      'https://registry.test/proxy',
    );
    const file = join(f.roots.home, '.skills-installer/config.json');
    const before = await readFile(file);
    for (const url of [
      'https://user:pass@registry.test',
      'https://registry.test?x',
      'https://registry.test#x',
      'file:///tmp',
      '',
    ]) {
      expect(runCliSync(f, ['config', 'set', 'registry', url]).status).toBe(1);
      expect(await readFile(file)).toEqual(before);
    }
    expect(runCliSync(f, ['config', 'unset', 'registry']).status).toBe(0);
    expect(runCliSync(f, ['config', 'get', 'registry']).stdout).toContain('config set registry');
    const find = runCliSync(f, ['find', 'document']);
    expect(find.status).toBe(1);
    expect(find.stderr).toContain('config set registry');
    expect(runCliSync(f, ['list']).status).toBe(0);
  });
});

it('uses explicit URL → env → saved URL, without localhost or authentication', async () => {
  await withTestEnvironment(async (f) => {
    const http = vi.fn<typeof fetch>();
    await writeRegistryConfig(f.roots, 'https://saved.test/proxy');
    const context = { ...f, http, env: { SKILLS_API_URL: 'https://env.test' } };
    expect(await resolveRegistryUrl('https://explicit.test', context)).toBe(
      'https://explicit.test',
    );
    expect(await resolveRegistryUrl(undefined, context)).toBe('https://env.test');
    expect(await resolveRegistryUrl(undefined, { ...context, env: {} })).toBe(
      'https://saved.test/proxy',
    );
    expect(() => getRegistryUrl(undefined, {})).toThrow('config set registry');
    expect(http).not.toHaveBeenCalled();
  });
});

const damagedConfigs = ['{broken', '{"registry":42}', '{"registry":"file:///tmp"}'];

it('executes config repair and damaged config diagnostics without HTTP', async () => {
  await withTestEnvironment(async (f) => {
    const http = vi.fn(f.http);
    const t = terminal(false, false);
    const context = {
      version: '0.0.0',
      runtime: { ...f, http },
      stdin: t.input,
      stdout: t.output,
      stderr: t.output,
    };
    const file = join(f.roots.home, '.skills-installer/config.json');
    await mkdir(join(f.roots.home, '.skills-installer'));
    try {
      for (const args of [
        ['config', 'get', 'registry'],
        ['find', 'docs'],
        ['add', 'docs', '-a', 'codex', '-y'],
      ]) {
        await writeFile(file, '{damaged');
        expect(await executeCli(context, args)).toBe(1);
      }
      for (const args of [
        ['config', 'set', 'registry', 'https://new.test'],
        ['config', 'unset', 'registry'],
      ]) {
        await writeFile(file, '{damaged');
        expect(await executeCli(context, args)).toBe(0);
      }
      expect(http).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });
});

it.each(damagedConfigs)(
  'repairs damaged config %s through set/unset in new processes',
  async (contents) => {
    await withTestEnvironment(async (f) => {
      const directory = join(f.roots.home, '.skills-installer');
      const file = join(directory, 'config.json');
      await mkdir(directory);
      for (const action of ['set', 'unset']) {
        await writeFile(file, contents);
        for (const args of [
          ['config', 'get', 'registry'],
          ['add', 'docs', '-y', '-a', 'codex'],
          ['find', 'docs'],
        ]) {
          const result = runCliSync(f, args);
          expect(result.status).toBe(1);
          expect(result.stderr).toContain(`Повреждён файл настроек: ${file}`);
          expect(result.stderr).toContain('config set registry');
          expect(result.stderr).toContain('config unset registry');
          expect(result.stderr).not.toMatch(/SyntaxError|Unexpected token|JSON at position/);
        }
        const http = vi.fn<typeof fetch>();
        expect(await resolveRegistryUrl('https://explicit.test', { ...f, http })).toBe(
          'https://explicit.test',
        );
        expect(
          await resolveRegistryUrl(undefined, {
            ...f,
            http,
            env: { SKILLS_API_URL: 'https://env.test' },
          }),
        ).toBe('https://env.test');
        expect(runCliSync(f, ['config', 'set', 'registry', 'invalid']).status).toBe(1);
        expect(await readFile(file, 'utf8')).toBe(contents);
        const args = [
          'config',
          action,
          'registry',
          ...(action === 'set' ? ['https://saved.test'] : []),
        ];
        expect(runCliSync(f, args).status).toBe(0);
        const read = runCliSync(f, ['config', 'get', 'registry']);
        expect(read.status).toBe(0);
        expect(read.stdout).toContain(
          action === 'set' ? 'https://saved.test' : 'Реестр не настроен',
        );
        expect(await readdir(directory)).toEqual(['config.json']);
        expect(http).not.toHaveBeenCalled();
      }
    });
  },
);

it.each(['write', 'sync', 'rename', 'cancel', 'access'] as const)(
  'preserves damaged bytes and cleans temporary files after %s failure',
  async (stage) => {
    await withTestEnvironment(async (f) => {
      const directory = join(f.roots.home, '.skills-installer');
      const file = join(directory, 'config.json');
      await mkdir(directory);
      await writeFile(file, '{damaged');
      const controller = new AbortController();
      const failure = Object.assign(new Error('injected I/O'), {
        code: 'EACCES',
        path: file,
        syscall: 'open',
      });
      vi.mocked(open).mockImplementation(async (...args) => {
        if (stage === 'access' && args[0] === file) throw failure;
        const handle = await actualFs.open(...args);
        if (String(args[0]).includes('.config-')) {
          if (stage === 'write') vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(failure);
          if (stage === 'sync') vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
          if (stage === 'cancel') {
            const sync = handle.sync.bind(handle);
            vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
              await sync();
              controller.abort(failure);
            });
          }
        }
        return handle;
      });
      if (stage === 'rename') vi.mocked(rename).mockRejectedValueOnce(failure);
      await expect(
        writeRegistryConfig(f.roots, 'https://new.test', controller.signal),
      ).rejects.toBe(failure);
      expect(await readFile(file, 'utf8')).toBe('{damaged');
      expect(await readdir(directory)).toEqual(['config.json']);
      if (stage === 'access') await expect(readRegistryConfig(f.roots)).rejects.toBe(failure);
    });
  },
);

it.each(['symlink', 'directory'] as const)('preserves a %s config and its target', async (kind) => {
  await withTestEnvironment(async (f) => {
    const directory = join(f.roots.home, '.skills-installer');
    const file = join(directory, 'config.json');
    const target = join(f.temporaryRoot, 'foreign');
    await mkdir(directory);
    await writeFile(target, 'foreign');
    if (kind === 'symlink') await symlink(target, file);
    else await mkdir(file);
    for (const value of [undefined, 'https://new.test'])
      await expect(writeRegistryConfig(f.roots, value)).rejects.toThrow(
        `обычный файл настроек: ${file}`,
      );
    await expect(readRegistryConfig(f.roots)).rejects.toThrow('обычный файл настроек');
    expect(await readFile(target, 'utf8')).toBe('foreign');
    expect((await lstat(file)).isSymbolicLink()).toBe(kind === 'symlink');
    expect(await readdir(directory)).toEqual(['config.json']);
  });
});

it.skipIf(process.platform === 'win32')(
  'rejects a FIFO before opening or replacing it',
  async () => {
    await withTestEnvironment(async (f) => {
      const directory = join(f.roots.home, '.skills-installer');
      const file = join(directory, 'config.json');
      await mkdir(directory);
      execFileSync('mkfifo', [file]);
      await expect(writeRegistryConfig(f.roots, 'https://new.test')).rejects.toThrow(
        'обычный файл настроек',
      );
      await expect(readRegistryConfig(f.roots)).rejects.toThrow('обычный файл настроек');
      expect((await lstat(file)).isFIFO()).toBe(true);
      expect(await readdir(directory)).toEqual(['config.json']);
    });
  },
);

it.each(['replacement', 'edit', 'symlink', 'appearance'] as const)(
  'refuses config %s while the temporary file is being saved',
  async (change) => {
    await withTestEnvironment(async (f) => {
      const directory = join(f.roots.home, '.skills-installer');
      const file = join(directory, 'config.json');
      const target = join(f.temporaryRoot, 'foreign');
      await mkdir(directory);
      await writeFile(target, 'new bytes');
      if (change !== 'appearance') await writeFile(file, '{damaged');
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await actualFs.open(...args);
        if (String(args[0]).includes('.config-')) {
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
            await sync();
            if (change === 'replacement') {
              await writeFile(join(directory, 'replacement'), 'new bytes');
              await actualFs.rename(join(directory, 'replacement'), file);
            } else if (change === 'symlink') {
              await unlink(file);
              await symlink(target, file);
            } else await writeFile(file, 'new bytes');
          });
        }
        return handle;
      });
      await expect(writeRegistryConfig(f.roots, 'https://new.test')).rejects.toThrow(
        change === 'symlink' ? /обычный файл настроек/ : /изменился во время записи/,
      );
      expect(await readFile(file, 'utf8')).toBe('new bytes');
      expect(await readFile(target, 'utf8')).toBe('new bytes');
      expect((await lstat(file)).isSymbolicLink()).toBe(change === 'symlink');
      expect(await readdir(directory)).toEqual(['config.json']);
    });
  },
);
