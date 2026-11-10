import { configureRegistry } from '@/cli/commands/config';
import { AGENTS } from '@/agents';
import type { Command } from 'commander';
import { RussianCommand } from './command';
import type { AddOptions, CliContext, FindOptions, MutationOptions, ScopeOptions } from './types';
import { addSkill } from '@/cli/commands/add';
import { findSkill } from '@/cli/commands/find';
import { listSkills } from '@/cli/commands/list';
import { updateSkills } from '@/cli/commands/update';
import { removeSkills } from '@/cli/commands/remove';

/** Регистрирует пять пакетных команд, их параметры и переданные потоки. */
export function createProgram(context: CliContext): Command {
  const program = new RussianCommand();
  program.configureOutput({
    writeOut: (message) => {
      context.stdout.write(message);
    },
    writeErr: (message) => {
      context.stderr.write(message);
    },
    getOutHelpWidth: () => context.stdout.columns ?? 80,
    getErrHelpWidth: () => context.stderr.columns ?? 80,
  });
  program
    .name('skills-installer')
    .description('Установка скиллов из реестра в проект или глобально.')
    .version(context.version, '-V, --version', 'показать версию CLI')
    .helpCommand('help [command]', 'показать справку по команде')
    .option('--without-stat', 'отключить статистику реестра для этой команды')
    .allowExcessArguments(false)
    .action(() => {
      program.outputHelp();
    });

  const agentHelp = `${[...AGENTS]
    .sort((a, b) => a.helpOrder - b.helpOrder)
    .map((agent) => agent.id)
    .join(', ')}; можно указать несколько раз`;
  const scope = (command: Command) =>
    command
      .option(
        '-a, --agent <agent>',
        agentHelp,
        (agent: string, previous: string[]) => [...previous, agent],
        [],
      )
      .option('-p, --project', 'использовать текущий проект')
      .option('-g, --global', 'использовать глобальную область');
  const yes = (command: Command) => command.option('-y, --yes', 'выполнить без диалогов');
  const skill = (command: Command) =>
    command.option(
      '--skill <name...>',
      'выбрать скиллы пакета; можно указать несколько имён или повторить флаг',
      [],
    );
  const registry = (command: Command) =>
    command.option(
      '--registry <url>',
      'базовый HTTP(S) URL реестра (приоритет выше SKILLS_API_URL)',
    );

  registry(
    yes(
      skill(
        scope(
          program
            .command('add')
            .description('Установить выбранные скиллы пакета из реестра')
            .argument('<package>', 'пакет или пакет@версия'),
        ),
      ),
    ),
  ).action((slug: string, _options: AddOptions, command: Command) =>
    addSkill(context, slug, command.optsWithGlobals<AddOptions>()),
  );

  scope(
    program.command('list').description('Показать установленные пакеты, версии, скиллы и агентов'),
  ).action((options: ScopeOptions) => listSkills(context, options));

  registry(
    yes(
      scope(
        program
          .command('find')
          .description('Найти скилл в реестре и выбрать для установки')
          .argument('[query]', 'текст поиска от 3 символов; обязателен без диалогов'),
      ),
    ),
  ).action((query: string | undefined, _options: FindOptions, command: Command) =>
    findSkill(context, query, command.optsWithGlobals<FindOptions>()),
  );

  yes(
    skill(
      scope(
        program
          .command('update')
          .description('Обновить установленные скиллы пакета до текущего релиза')
          .argument('[package]', 'пакет; без имени — все подходящие пакеты'),
      ),
    ),
  ).action((slug: string | undefined, _options: MutationOptions, command: Command) =>
    updateSkills(context, slug, command.optsWithGlobals<MutationOptions>()),
  );

  yes(
    skill(
      scope(
        program
          .command('remove')
          .description('Удалить выбранные подключения скиллов пакета')
          .argument('[package]', 'установленный пакет; обязателен с --yes'),
      ),
    ),
  ).action((slug: string | undefined, options: MutationOptions) =>
    removeSkills(context, slug, options),
  );

  const config = program.command('config').description('Настроить реестр');
  for (const action of ['set', 'get', 'unset'] as const) {
    const command = config.command(action).argument('<key>', 'registry');
    if (action === 'set') command.argument('<url>', 'базовый HTTP(S) URL');
    command.action((key: string, value: string | undefined) =>
      configureRegistry(context, action, key, value),
    );
  }
  return program;
}
