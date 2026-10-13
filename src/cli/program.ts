import { AGENTS } from '../agents/catalog.ts';
import { errorMessage } from '../errors.ts';
import { Command } from 'commander';
import { parseAgents } from '../installer/agents.ts';
import { Installer } from '../installer/installer.ts';
import type { InstallationChange, RegistrySelection } from '../installer/types.ts';
import type { InstallationScope } from '../installer/types.ts';
import type { RuntimeContext } from '../runtime.ts';
import { selectAgents, type PromptStreams } from './agents-prompt.ts';
import { createUpdatesUi } from './updates-ui.ts';
import { renderSkillList } from './list-ui.ts';
import { RegistryClient } from '../registry/client.ts';
import { getRegistryUrl } from '../registry/reference.ts';
import { sortCatalog } from '../registry/catalog.ts';
import { Telemetry } from '../telemetry/client.ts';
import { renderSearch } from './discovery-ui.ts';
import { selectRegistrySkill } from './find-ui.ts';
import { canSearchPrefix, MIN_FIND_PREFIX_LENGTH } from './find-search.ts';
import { createAddUi, selectScope } from './add-ui.ts';
import { createRemoveUi } from './remove-ui.ts';
import { assertSkillName } from '../state/paths.ts';
import { RussianCommand } from './command.ts';
import { failureLabel } from './labels.ts';

export interface CliOutput {
  readonly write: (message: string) => void;
}

interface AddOptions {
  readonly agent: string[];
  readonly global?: boolean;
  readonly force?: boolean;
  readonly registry?: string;
  readonly yes?: boolean;
}

/**
 * Создаёт команды Commander и связывает их с Installer, диалогами и телеметрией.
 *
 * @remarks Регистрация не запускает операции; выполнение начинается при parseAsync. Корни и HTTP берутся
 * из context.
 */
export function createProgram(
  version: string,
  context: RuntimeContext,
  output: CliOutput,
  streams: PromptStreams = { input: process.stdin, output: process.stdout },
): Command {
  const program = new RussianCommand();
  program
    .name('skills-installer')
    .description('Установка и управление скиллами для пяти агентов в проекте или глобально.')
    .version(version, '-V, --version', 'показать версию CLI')
    .helpCommand('help [command]', 'показать справку по команде')
    .option('--without-stat', 'отключить статистику реестра для этой команды')
    .allowExcessArguments(false)
    .action(() => {
      program.outputHelp();
    });
  const collectAgent = (agent: string, previous: string[]) => [...previous, agent];
  const scopeOf = (options: { global?: boolean }): InstallationScope =>
    options.global ? 'global' : 'project';
  const installer = (options: { global?: boolean; registry?: string }) =>
    new Installer(context, {
      scope: scopeOf(options),
      report: output.write,
      ...(options.registry === undefined ? {} : { registry: options.registry }),
    });
  /** Преобразует partial/failed в ошибку CLI с диагностикой отдельных подключений. */
  const checkResult = (result: InstallationChange) => {
    if (result.status === 'partial' || result.status === 'failed')
      throw new Error(`${failureLabel(result.status)}: ${result.errors.join('; ')}`);
  };
  const agentHelp = `${[...AGENTS]
    .sort((a, b) => a.helpOrder - b.helpOrder)
    .map((agent) => agent.id)
    .join(', ')}; можно указать несколько раз`;
  const telemetryFor = (command: Command) =>
    new Telemetry(context, version, { disabled: !!command.optsWithGlobals().withoutStat });
  const registryClient = (registry?: string) =>
    new RegistryClient(getRegistryUrl(registry, context.env), context.http);
  /**
   * Выполняет общий сценарий add/find: область, агенты, карточка, установка и вывод результата. До чтения
   * источника проверяет non-TTY-параметры; по завершении ожидает доставку телеметрии.
   */
  const addSkill = async (
    source: string,
    options: AddOptions,
    command: Command,
    reference?: RegistrySelection,
  ) => {
    parseAgents(options.agent);
    const scope = await selectScope(options.global, context, streams);
    if (scope === null) {
      output.write('Отменено.');
      return;
    }
    const agents = await selectAgents(options.agent, context, scope, streams);
    if (agents === null) {
      output.write('Отменено.');
      return;
    }
    if ((!streams.input.isTTY || !streams.output.isTTY) && !options.yes)
      throw new Error(
        'Для подтверждения установки нужны stdin и stdout терминала (TTY); в скриптах используйте --yes.',
      );
    const ui = createAddUi(context, streams, options.yes);
    const telemetry = telemetryFor(command);
    const target = new Installer(context, {
      scope,
      report: output.write,
      telemetry,
      reviewAdd: ui.review,
      signal: ui.signal,
      ...(options.registry === undefined ? {} : { registry: options.registry }),
    });
    const result = await ui
      .run(() =>
        reference
          ? target.addRegistry(reference, options.force, agents)
          : target.add(source, options.force, agents),
      )
      .finally(() => telemetry.flush());
    if (result.status === 'skipped') {
      output.write(result.reason === 'cancelled' ? 'Отменено.' : 'Установка отклонена.');
      return;
    }
    if (result.status !== 'failed')
      output.write(
        result.status === 'partial'
          ? `Частично установлен ${result.name}.`
          : `${result.status === 'unchanged' ? 'Без изменений' : 'Установлен'} ${result.name} (${agents.join(', ')}).`,
      );
    checkResult(result);
  };

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
    .action(addSkill);

  program
    .command('list')
    .description('Показать установленные скиллы, версии, политики и агентов')
    .option('-a, --agent <agent>', agentHelp, collectAgent, [])
    .option('-g, --global', 'использовать глобальную область')
    .action(async (options: { agent: string[]; global?: boolean }) => {
      const agents = parseAgents(options.agent);
      const records = await installer(options).list(agents);
      renderSkillList(records, scopeOf(options), agents, streams);
    });

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
    .action(async (prefix: string | undefined, options: AddOptions, command: Command) => {
      parseAgents(options.agent);
      const query = prefix ?? '';
      const interactive = streams.input.isTTY && streams.output.isTTY;
      if (!interactive && (!query.trim() || !canSearchPrefix(query)))
        throw new Error(
          `Для интерактивного find нужны stdin и stdout терминала (TTY); используйте find <slug-prefix> с префиксом длиной от ${MIN_FIND_PREFIX_LENGTH} символов, чтобы показать результаты без установки.`,
        );
      const client = registryClient(options.registry);
      if (!interactive) {
        renderSearch(sortCatalog(await client.listSkills(query)), streams.output);
        return;
      }
      const selected = await selectRegistrySkill(client, query, streams);
      if (selected === null) {
        output.write('Отменено.');
        return;
      }
      const reference: RegistrySelection = {
        slug: selected.slug,
        version: selected.currentVersion,
        policy: 'latest',
      };
      output.write(`Выбран ${selected.slug}@${selected.currentVersion}.`);
      await addSkill(
        `${selected.slug}@${selected.currentVersion}`,
        { ...options, registry: client.registryUrl },
        command,
        reference,
      );
    });

  program
    .command('update')
    .description('Обновить скиллы из сохранённых источников; пропустить закреплённые версии')
    .argument('[name]', 'имя установленного скилла; без имени — все подходящие скиллы')
    .option('-a, --agent <agent>', agentHelp, collectAgent, [])
    .option('-g, --global', 'использовать глобальную область')
    .option('--force', 'заменить изменённое содержимое; закреплённые версии остаются закреплёнными')
    .option('-y, --yes', 'обновить без подтверждения (обязательно для изменений без TTY)')
    .option('--without-stat', 'отключить статистику скачиваний и установок из реестра')
    .action(
      async (
        name: string | undefined,
        options: { agent: string[]; global?: boolean; force?: boolean; yes?: boolean },
        command: Command,
      ) => {
        const ui = createUpdatesUi(streams, options.yes, scopeOf(options));
        const telemetry = telemetryFor(command);
        const result = await new Installer(context, {
          scope: scopeOf(options),
          report: ui.report,
          reviewUpdate: ui.review,
          telemetry,
        })
          .update(name, options.force, parseAgents(options.agent))
          .finally(() => telemetry.flush());
        ui.finish(result);
        if (result.status === 'failed')
          throw new Error('Не удалось обновить один или несколько скиллов.');
      },
    );

  program
    .command('remove')
    .description('Выбрать скиллы и подтвердить удаление; без -a удалить все подключения')
    .argument('[names...]', 'имена установленных скиллов; без имён — интерактивный выбор')
    .option('-a, --agent <agent>', agentHelp, collectAgent, [])
    .option('-g, --global', 'использовать глобальную область')
    .option('-y, --yes', 'удалить без подтверждения (обязательно без TTY)')
    .action(
      async (names: string[], options: { agent: string[]; global?: boolean; yes?: boolean }) => {
        const agents = parseAgents(options.agent);
        const requested = [...new Set(names)];
        requested.forEach(assertSkillName);
        if (!requested.length && (!streams.input.isTTY || !streams.output.isTTY))
          throw new Error(
            'Для выбора скиллов нужны stdin и stdout терминала (TTY); в скриптах используйте remove demo --yes.',
          );
        const target = installer(options);
        const records = await target.list(agents);
        const ui = createRemoveUi(streams, scopeOf(options), agents, options.yes);
        const byName = new Map(records.map((record) => [record.name, record]));
        const matching = requested.flatMap((name) => {
          const record = byName.get(name);
          if (record) return [record];
          ui.missing(name);
          return [];
        });
        if (!records.length || (requested.length && !matching.length)) {
          ui.empty();
          return;
        }
        const selected = requested.length ? matching : await ui.select(records);
        if (selected === null || !(await ui.review(selected))) return;
        const results: InstallationChange[] = [];
        for (const record of selected) {
          try {
            const affected = record.agents.filter(
              (agent) => !agents.length || agents.includes(agent),
            );
            results.push(await target.remove(record.name, affected));
          } catch (cause) {
            results.push({
              name: record.name,
              status: 'failed',
              errors: [errorMessage(cause)],
            });
          }
        }
        ui.finish(selected, results);
        const errors = results.flatMap((result) =>
          result.status === 'partial' || result.status === 'failed' ? result.errors : [],
        );
        if (results.some((result) => result.status === 'partial' || result.status === 'failed'))
          throw new Error(`Не удалось удалить один или несколько скиллов: ${errors.join('; ')}`);
      },
    );

  return program;
}
