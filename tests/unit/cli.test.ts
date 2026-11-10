import { describe, expect, it, vi } from 'vitest';
import manifest from '../../package.json' with { type: 'json' };
import { createProgram } from '@/cli/program';
import { Installer } from '@/installer/installer';
import { withTestEnvironment } from '../helpers/test-environment.ts';
import { terminal } from '../helpers/terminal.ts';

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
    ...(
      [
        ['--limit', '25'],
        ['--sort', 'name'],
      ] as const
    ).map(([flag, value]) => ({
      args: ['find', 'document', flag, value],
      text: new RegExp(`неизвестный параметр.*${flag}`),
      code: 'commander.unknownOption',
    })),
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
      args: ['add', 'docs', '--force'],
      text: /неизвестный параметр.*--force/,
      code: 'commander.unknownOption',
    },
  ])('$args reports $code without invoking a business operation', async ({ args, text, code }) => {
    await withTestEnvironment(async (context) => {
      const add = vi.spyOn(Installer.prototype, 'add'),
        list = vi.spyOn(Installer.prototype, 'list');
      const http = vi.fn(context.http);
      let rendered = '';
      const t = terminal(false, false),
        program = createProgram({
          version: manifest.version,
          runtime: { ...context, http },
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
        if (args.includes('--help')) expect(rendered).not.toMatch(/--(?:limit|sort)\b/);
        expect(http).not.toHaveBeenCalled();
        expect(add).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
      } finally {
        t.close();
      }
    });
  });
});
