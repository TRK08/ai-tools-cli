import { describe, expect, it, vi } from 'vitest';
import manifest from '../../package.json' with { type: 'json' };
import { createProgram } from '../../src/cli/program.ts';
import { Installer } from '../../src/installer/installer.ts';
import type { InstallationRecord } from '../../src/state/types.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';
import { catalogItem } from '../helpers/discovery.ts';
import { terminal } from '../helpers/terminal.ts';

const record = (name: string): InstallationRecord => ({
  name,
  source: { kind: 'directory', path: '/source' },
  version: null,
  policy: 'local',
  contentHash: 'a'.repeat(64),
  agents: ['codex', 'pi'],
  connections: [
    { agent: 'codex', kind: 'direct', path: `.agents/skills/${name}` },
    { agent: 'pi', kind: 'direct', path: `.agents/skills/${name}` },
  ],
});

describe('command registration and Russian diagnostics', () => {
  it.each([
    { args: ['--help'], text: /Использование: skills-installer/, code: 'commander.helpDisplayed' },
    {
      args: ['--version'],
      text: new RegExp(manifest.version.replaceAll('.', '\\.')),
      code: 'commander.version',
    },
    ...['add', 'list', 'find', 'update', 'remove'].map((command) => ({
      args: [command, '--help'],
      text: new RegExp(`Использование: skills-installer ${command}`),
      code: 'commander.helpDisplayed',
    })),
    ...['install', 'info', 'search', 'restore', 'unknown-command'].map((command) => ({
      args: [command],
      text: new RegExp(command),
      code: 'commander.excessArguments',
    })),
    { args: ['--unknown-option'], text: /неизвестный параметр/, code: 'commander.unknownOption' },
    { args: ['add'], text: /отсутствует обязательный аргумент/, code: 'commander.missingArgument' },
    {
      args: ['add', '--agent'],
      text: /не указано значение/,
      code: 'commander.optionMissingArgument',
    },
    {
      args: ['update', 'demo', 'other'],
      text: /слишком много аргументов/,
      code: 'commander.excessArguments',
    },
    {
      args: ['add', '--forc'],
      text: /Возможно, вы имели в виду --force/,
      code: 'commander.unknownOption',
    },
  ])('$args reports $code without invoking a business operation', async ({ args, text, code }) => {
    await withTestEnvironment(async (context) => {
      const add = vi.spyOn(Installer.prototype, 'add'),
        list = vi.spyOn(Installer.prototype, 'list');
      let rendered = '';
      const t = terminal(false, false),
        program = createProgram({
          version: manifest.version,
          runtime: context,
          stdin: t.input,
          stdout: t.output,
          stderr: t.output,
        });
      for (const command of [program, ...program.commands])
        command.exitOverride().configureOutput({
          writeOut: (value) => {
            rendered += value;
          },
          writeErr: (value) => {
            rendered += value;
          },
        });
      try {
        await expect(program.parseAsync(args, { from: 'user' })).rejects.toMatchObject({ code });
        expect(rendered).toMatch(text);
        expect(rendered).not.toMatch(/Usage:|Options:|Arguments:|Commands:|\[options\]/);
        expect(add).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
      } finally {
        t.close();
      }
    });
  });
});

describe('CLI orchestration with isolated Installer operations', () => {
  it('forwards find --force, selected version and latest policy to addRegistry', async () => {
    await withTestEnvironment(async (fixture) => {
      const http = vi.fn<typeof fetch>(async () =>
        Response.json({ items: [catalogItem({ currentVersion: '1.0.0' })] }),
      );
      const add = vi
        .spyOn(Installer.prototype, 'addRegistry')
        .mockResolvedValue({ name: 'demo', status: 'success' });
      const t = terminal();
      try {
        const pending = createProgram({
          version: 'test',
          runtime: { ...fixture, http },
          stdin: t.input,
          stdout: t.output,
          stderr: t.output,
        }).parseAsync(
          [
            'find',
            'de',
            '-g',
            '-a',
            'codex',
            '--force',
            '--yes',
            '--registry',
            'https://registry.test',
          ],
          { from: 'user' },
        );
        await vi.waitFor(() => expect(t.rendered()).toContain('demo'));
        t.input.write('\r');
        await pending;
        expect(add).toHaveBeenCalledExactlyOnceWith(
          { slug: 'demo', version: '1.0.0', policy: 'latest' },
          true,
          ['codex'],
        );
      } finally {
        t.close();
      }
    });
  });
  it('propagates find API errors without printing an empty-result message', async () => {
    await withTestEnvironment(async (fixture) => {
      const t = terminal(false, false);
      try {
        await expect(
          createProgram({
            version: 'test',
            runtime: { ...fixture, http: async () => new Response(null, { status: 503 }) },
            stdin: t.input,
            stdout: t.output,
            stderr: t.output,
          }).parseAsync(['find', 'demo'], { from: 'user' }),
        ).rejects.toThrow('HTTP 503');
        expect(t.rendered()).not.toContain('Скиллы не найдены');
      } finally {
        t.close();
      }
    });
  });
  it.each(['empty', 'filter', 'unknown'] as const)(
    'finishes removal without a prompt for %s results',
    async (kind) => {
      await withTestEnvironment(async (context) => {
        const list = vi
          .spyOn(Installer.prototype, 'list')
          .mockResolvedValue(kind === 'unknown' ? [record('demo')] : []);
        const remove = vi.spyOn(Installer.prototype, 'remove'),
          t = terminal();
        try {
          await createProgram({
            version: 'test',
            runtime: context,
            stdin: t.input,
            stdout: t.output,
            stderr: t.output,
          }).parseAsync(
            [
              'remove',
              ...(kind === 'filter' ? ['-a', 'pi'] : kind === 'unknown' ? ['missing'] : []),
            ],
            { from: 'user' },
          );
          expect(list).toHaveBeenCalledExactlyOnceWith(kind === 'filter' ? ['pi'] : []);
          expect(remove).not.toHaveBeenCalled();
          expect(t.input.setRawMode).not.toHaveBeenCalled();
        } finally {
          t.close();
        }
      });
    },
  );

  it('updates saved agents without opening selection even with TTY and --yes', async () => {
    await withTestEnvironment(async (context) => {
      const update = vi
        .spyOn(Installer.prototype, 'update')
        .mockResolvedValue({ status: 'success', results: [] });
      const t = terminal();
      try {
        await createProgram({
          version: 'test',
          runtime: context,
          stdin: t.input,
          stdout: t.output,
          stderr: t.output,
        }).parseAsync(['update', '--yes'], { from: 'user' });
        expect(update).toHaveBeenCalledExactlyOnceWith(undefined, undefined, []);
        expect(t.input.setRawMode).not.toHaveBeenCalled();
      } finally {
        t.close();
      }
    });
  });

  it.each(['selection', 'confirmation'] as const)(
    'does not remove after %s cancellation',
    async (stage) => {
      await withTestEnvironment(async (context) => {
        vi.spyOn(Installer.prototype, 'list').mockResolvedValue([record('demo')]);
        const remove = vi.spyOn(Installer.prototype, 'remove');
        const t = terminal();
        try {
          const pending = createProgram({
            version: 'test',
            runtime: context,
            stdin: t.input,
            stdout: t.output,
            stderr: t.output,
          }).parseAsync(stage === 'selection' ? ['remove', '--yes'] : ['remove', 'demo'], {
            from: 'user',
          });
          await vi.waitFor(() =>
            expect(t.rendered()).toContain(
              stage === 'selection' ? 'Выберите скиллы' : 'Нет, оставить',
            ),
          );
          t.input.write('\u0003');
          await pending;
          expect(remove).not.toHaveBeenCalled();
        } finally {
          t.close();
        }
      });
    },
  );

  it('passes explicit deduplicated agents, source and force to add', async () => {
    await withTestEnvironment(async (context) => {
      const add = vi
        .spyOn(Installer.prototype, 'add')
        .mockResolvedValue({ name: 'demo', status: 'success' });
      const t = terminal(false, false);
      try {
        await createProgram({
          version: 'test',
          runtime: context,
          stdin: t.input,
          stdout: t.output,
          stderr: t.output,
        }).parseAsync(
          ['add', 'source', '-a', 'pi', '-a', 'codex', '-a', 'pi', '--force', '--yes'],
          { from: 'user' },
        );
        expect(add).toHaveBeenCalledExactlyOnceWith('source', true, ['codex', 'pi']);
      } finally {
        t.close();
      }
    });
  });
  it.each(
    [
      ['add', 'source'],
      ['add', 'source', '-a', 'codex'],
      ['find', 'd'],
      ['remove'],
      ['remove', '*', '--yes'],
      ['remove', '../escape', '--yes'],
      ['add', 'source', '-a', 'codex', '--force'],
      ['list', '-a', 'unknown'],
    ].map((args) => ({ args })),
  )('rejects unsafe/noninteractive arguments before a mutation: %j', async ({ args }) => {
    await withTestEnvironment(async (context) => {
      const add = vi.spyOn(Installer.prototype, 'add'),
        remove = vi.spyOn(Installer.prototype, 'remove');
      const t = terminal(false, false);
      try {
        await expect(
          createProgram({
            version: 'test',
            runtime: context,
            stdin: t.input,
            stdout: t.output,
            stderr: t.output,
          }).parseAsync(args, { from: 'user' }),
        ).rejects.toThrow();
        expect(add).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
      } finally {
        t.close();
      }
    });
  });
  it('deduplicates named removals, limits affected agents and continues after an error', async () => {
    await withTestEnvironment(async (context) => {
      const list = vi
        .spyOn(Installer.prototype, 'list')
        .mockResolvedValue([record('demo'), record('other')]);
      const remove = vi
        .spyOn(Installer.prototype, 'remove')
        .mockRejectedValueOnce(new Error('first failure'))
        .mockResolvedValueOnce({ name: 'other', status: 'success' });
      const t = terminal(false, false);
      try {
        await expect(
          createProgram({
            version: 'test',
            runtime: context,
            stdin: t.input,
            stdout: t.output,
            stderr: t.output,
          }).parseAsync(['remove', 'demo', 'demo', 'other', 'missing', '-a', 'codex', '--yes'], {
            from: 'user',
          }),
        ).rejects.toThrow('Не удалось удалить');
        expect(list).toHaveBeenCalledExactlyOnceWith(['codex']);
        expect(remove.mock.calls).toEqual([
          ['demo', ['codex']],
          ['other', ['codex']],
        ]);
        expect(t.rendered()).toContain('missing');
        expect(t.rendered()).toContain('first failure');
      } finally {
        t.close();
      }
    });
  });
  it('renders a partial update and rejects it without hiding successful batch results', async () => {
    await withTestEnvironment(async (context) => {
      const update = vi.spyOn(Installer.prototype, 'update').mockResolvedValue({
        status: 'failed',
        results: [
          { name: 'demo', status: 'success' },
          { name: 'other', status: 'partial', errors: ['connection failure'] },
        ],
      });
      const t = terminal(false, false);
      try {
        await expect(
          createProgram({
            version: 'test',
            runtime: context,
            stdin: t.input,
            stdout: t.output,
            stderr: t.output,
          }).parseAsync(['update', '--yes', '--force', '-a', 'pi'], { from: 'user' }),
        ).rejects.toThrow('Не удалось обновить');
        expect(update).toHaveBeenCalledExactlyOnceWith(undefined, true, ['pi']);
        expect(t.rendered()).toContain('Обновлён');
        expect(t.rendered()).toContain('connection failure');
      } finally {
        t.close();
      }
    });
  });
});
