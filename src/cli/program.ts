import { AGENTS } from '../agents/catalog.ts';
import type { Command } from 'commander';
import { RussianCommand } from './command.ts';
import type {
  AddOptions,
  CliContext,
  MutationOptions,
  ScopeOptions,
  UpdateOptions,
} from './types.ts';
import { addSkill } from './commands/add.ts';
import { findSkill } from './commands/find.ts';
import { listSkills } from './commands/list.ts';
import { updateSkills } from './commands/update.ts';
import { removeSkills } from './commands/remove.ts';

/** Регистрирует русский CLI и переданные потоки; операции начинаются только при parseAsync. */
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
    .description('Установка и управление скиллами для пяти агентов в проекте или глобально.')
    .version(context.version, '-V, --version', 'показать версию CLI')
    .helpCommand('help [command]', 'показать справку по команде')
    .option('--without-stat', 'отключить статистику реестра для этой команды')
    .allowExcessArguments(false)
    .action(() => {
      program.outputHelp();
    });
  const collectAgent = (agent: string, previous: string[]) => [...previous, agent];
  const agentHelp = `${[...AGENTS]
    .sort((a, b) => a.helpOrder - b.helpOrder)
    .map((agent) => agent.id)
    .join(', ')}; можно указать несколько раз`;
  program
    .command('add')
    .description('Установить скилл из папки, архива или реестра; без -a выбрать агентов')
    .argument('<source>', 'локальная папка, .tar.gz/.tgz, slug или slug@version')
    .option('-a, --agent <agent>', agentHelp, collectAgent, [])
    .option('-g, --global', 'использовать глобальную область')
    .option('--force', 'заменить изменённое содержимое управляемого скилла')
    .option('--registry <url>', 'базовый HTTP(S) URL реестра (приоритет выше SKILLS_API_URL)')
    .option('--without-stat', 'отключить статистику скачиваний и установок из реестра')
    .option('-y, --yes', 'установить без итогового подтверждения (обязательно без TTY)')
    .action((source: string, _options: AddOptions, command: Command) =>
      addSkill(context, source, command.optsWithGlobals<AddOptions>()),
    );

  program
    .command('list')
    .description('Показать установленные скиллы, версии и агентов')
    .option('-a, --agent <agent>', agentHelp, collectAgent, [])
    .option('-g, --global', 'использовать глобальную область')
    .action((options: ScopeOptions) => listSkills(context, options));

  program
    .command('find')
    .description('Найти скилл в реестре, выбрать и установить в терминале')
    .argument('[slug-prefix]', 'префикс slug с учётом регистра (от 2 символов); обязателен без TTY')
    .option('-a, --agent <agent>', agentHelp, collectAgent, [])
    .option('-g, --global', 'установить выбранный скилл глобально')
    .option('--force', 'заменить изменённое содержимое после выбора скилла')
    .option('--registry <url>', 'базовый HTTP(S) URL реестра (приоритет выше SKILLS_API_URL)')
    .option('--without-stat', 'отключить статистику выбранной установки')
    .option('-y, --yes', 'установить без итогового подтверждения')
    .action((prefix: string | undefined, _options: AddOptions, command: Command) =>
      findSkill(context, prefix, command.optsWithGlobals<AddOptions>()),
    );

  program
    .command('update')
    .description('Обновить скиллы из сохранённых источников; пропустить закреплённые версии')
    .argument('[name]', 'имя установленного скилла; без имени — все подходящие скиллы')
    .option('-a, --agent <agent>', agentHelp, collectAgent, [])
    .option('-g, --global', 'использовать глобальную область')
    .option('--force', 'заменить изменённое содержимое; закреплённые версии остаются закреплёнными')
    .option('-y, --yes', 'обновить без подтверждения (обязательно для изменений без TTY)')
    .option('--without-stat', 'отключить статистику скачиваний и установок из реестра')
    .action((name: string | undefined, _options: UpdateOptions, command: Command) =>
      updateSkills(context, name, command.optsWithGlobals<UpdateOptions>()),
    );

  program
    .command('remove')
    .description('Выбрать скиллы и подтвердить удаление; без -a удалить все подключения')
    .argument('[names...]', 'имена установленных скиллов; без имён — интерактивный выбор')
    .option('-a, --agent <agent>', agentHelp, collectAgent, [])
    .option('-g, --global', 'использовать глобальную область')
    .option('-y, --yes', 'удалить без подтверждения (обязательно без TTY)')
    .action((names: string[], options: MutationOptions) => removeSkills(context, names, options));

  return program;
}
