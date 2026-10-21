import { parseAgents } from '../../installer/agents.ts';
import { Installer } from '../../installer/installer.ts';
import type { InstallationChange } from '../../installer/types.ts';
import { assertSkillName } from '../../state/paths.ts';
import { errorMessage } from '../../errors.ts';
import { createLoading } from '../terminal/loading.ts';
import { createRemoveUi } from '../ui/remove-ui.ts';
import { promptStreams, scopeOf } from '../context.ts';
import type { CliContext, MutationOptions } from '../types.ts';

/** Подтверждает список и удаляет только показанные подключения; ошибка элемента не останавливает пакет. */
export async function removeSkills(
  context: CliContext,
  names: string[],
  options: MutationOptions,
): Promise<void> {
  const streams = promptStreams(context);
  const agents = parseAgents(options.agent);
  const requested = [...new Set(names)];
  requested.forEach(assertSkillName);
  if (!requested.length && (!streams.input.isTTY || !streams.output.isTTY))
    throw new Error(
      'Для выбора скиллов нужны stdin и stdout терминала (TTY); в скриптах используйте remove demo --yes.',
    );
  const target = new Installer(context.runtime, {
    scope: scopeOf(options),
    report: (message) => context.stdout.write(`${message}\n`),
  });
  const loading = createLoading(streams);
  const records = await loading.run('Чтение установленных скиллов…', () => target.list(agents));
  const ui = createRemoveUi(streams, scopeOf(options), agents);
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
  if (selected === null) return;
  ui.preview(selected);
  if (!options.yes) {
    if (!streams.input.isTTY || !streams.output.isTTY)
      throw new Error(
        'Для подтверждения удаления нужны stdin и stdout терминала (TTY); в скриптах используйте remove <name> --yes.',
      );
    if (!(await ui.review(selected))) return;
  }
  const results: InstallationChange[] = [];
  await loading.run('Удаление скиллов…', async () => {
    for (const record of selected) {
      try {
        const affected = record.agents.filter((agent) => !agents.length || agents.includes(agent));
        results.push(await target.remove(record.name, affected));
      } catch (cause) {
        results.push({
          name: record.name,
          status: 'failed',
          errors: [errorMessage(cause)],
        });
      }
    }
  });
  ui.finish(selected, results);
  const errors = results.flatMap((result) =>
    result.status === 'partial' || result.status === 'failed' ? result.errors : [],
  );
  if (results.some((result) => result.status === 'partial' || result.status === 'failed'))
    throw new Error(`Не удалось удалить один или несколько скиллов: ${errors.join('; ')}`);
}
