import { Command, Help, type ErrorOptions } from 'commander';

const titles: Record<string, string> = {
  'Usage:': 'Использование:',
  'Arguments:': 'Аргументы:',
  'Options:': 'Параметры:',
  'Global Options:': 'Общие параметры:',
  'Commands:': 'Команды:',
};

// Переводится только генерируемый синтаксис Commander; описания и данные сохраняются.
/** Переводит только служебные обозначения синтаксиса Commander; пользовательские данные сохраняет. */
function usage(value: string): string {
  return value.replaceAll('[options]', '[параметры]').replaceAll('[command]', '[команда]');
}

export class RussianCommand extends Command {
  /** Настраивает русскую справку Commander и описания стандартных параметров. */
  constructor(name?: string) {
    super(name);
    this.helpOption('-h, --help', 'показать справку по команде');
    this.configureHelp({
      styleTitle: (title) => titles[title] ?? title,
      commandUsage: (command) =>
        usage(Help.prototype.commandUsage.call(this.createHelp(), command)),
      subcommandTerm: (command) =>
        usage(Help.prototype.subcommandTerm.call(this.createHelp(), command)),
    });
  }

  /** Создаёт дочернюю команду с той же русской справкой и обработкой ошибок. */
  override createCommand(name?: string): Command {
    return new RussianCommand(name);
  }

  /**
   * Переводит стандартные ошибки аргументов и подсказки Commander, сохраняя имена и параметры. Затем
   * передаёт ошибку штатному обработчику Commander; управление не возвращается.
   */
  override error(message: string, options?: ErrorOptions): never {
    switch (options?.code) {
      case 'commander.missingArgument':
        message = message.replace(
          /^error: missing required argument /,
          'Ошибка: отсутствует обязательный аргумент ',
        );
        break;
      case 'commander.optionMissingArgument':
        message = message.replace(
          /^error: option (.*) argument missing$/,
          'Ошибка: для параметра $1 не указано значение',
        );
        break;
      case 'commander.unknownOption':
        message = message.replace(/^error: unknown option /, 'Ошибка: неизвестный параметр ');
        break;
      case 'commander.unknownCommand':
        message = message.replace(/^error: unknown command /, 'Ошибка: неизвестная команда ');
        break;
      case 'commander.excessArguments':
        message = `Ошибка: слишком много аргументов${this.parent ? ` для команды '${this.name()}'` : ''}. Ожидалось: ${this.registeredArguments.length}, получено: ${this.args.length}: ${this.args.join(', ')}.`;
        break;
    }
    message = message
      .replace(
        /\n\(Did you mean one of ([^\n]*)\?\)$/,
        '\n(Возможно, вы имели в виду один из вариантов: $1?)',
      )
      .replace(/\n\(Did you mean ([^\n]*)\?\)$/, '\n(Возможно, вы имели в виду $1?)');
    return super.error(message, options);
  }
}
