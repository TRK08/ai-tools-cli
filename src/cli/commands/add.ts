import { resolveRegistryUrl } from '@/config';
import { parseAgents } from '@/agents';
import { Installer } from '@/installer';
import { Telemetry } from '@/telemetry';
import { parseRegistryReference, RegistryClient } from '@/registry';
import { requireMutationTty, selectAgents, selectScope } from './selection';
import { confirmAdd } from '@/cli/ui/add-confirm';
import { runAddPreparation } from '@/cli/ui/add-ui';
import { chooseAll, showPackagePreview, showPackageResult } from '@/cli/ui/package-ui';
import { promptStreams, scopeOf } from '@/cli/context';
import type { AddOptions, CliContext } from '@/cli/types';

/**
 * Проверяет релиз и явный состав до установочных вопросов, затем добавляет выбранные скиллы.
 * Find использует тот же путь с точной версией; полученные метаданные повторно не запрашиваются.
 */
export async function addSkill(
  context: CliContext,
  input: string,
  options: AddOptions,
): Promise<void> {
  const streams = promptStreams(context);
  const reference = parseRegistryReference(input);
  if (!reference) throw new Error('Укажите пакет реестра в форме <package>[@version].');
  requireMutationTty(streams, options.yes);
  scopeOf(options);
  const explicit = parseAgents(options.agent);
  if (options.yes && !explicit.length) throw new Error('Для add --yes явно укажите -a <agent>.');
  const cancelled = () => showPackageResult(null, '', context.stdout);
  const client = new RegistryClient(
    await resolveRegistryUrl(options.registry, context.runtime),
    context.runtime.http,
  );
  const release = await runAddPreparation(
    streams,
    'Получение релиза… Esc / Ctrl+C — отмена',
    (signal) => client.getPackage(reference, signal),
    options.yes,
  );
  if (release === null) return cancelled();
  if (!release.skills.length)
    throw new Error(`В релизе ${release.slug}@${release.version} нет скиллов.`);
  for (const name of options.skill) {
    if (!release.skills.some((item) => item.name === name))
      throw new Error(`Скилл ${name} отсутствует в релизе ${release.slug}@${release.version}.`);
  }
  const scope = await selectScope(options, context.runtime, streams);
  if (scope === null) return cancelled();
  const chosen =
    options.yes || options.skill.length
      ? options.skill
      : await chooseAll(
          `Выберите скиллы пакета ${release.slug}@${release.version}`,
          release.skills.map((item) => ({ value: item.name, label: item.name, hint: item.title })),
          streams,
        );
  if (chosen === null) return cancelled();
  const agents = await selectAgents(explicit, context.runtime, scope, streams);
  if (agents === null) return cancelled();
  const telemetry = new Telemetry(context.runtime, { disabled: !!options.withoutStat });
  const installer = new Installer(context.runtime, { scope, telemetry });
  const result = await runAddPreparation(
    streams,
    'Проверка установок… Esc / Ctrl+C — отмена',
    (signal, stop) =>
      installer.add(
        client,
        release,
        chosen,
        agents,
        async (preview) => {
          stop();
          signal.throwIfAborted();
          showPackagePreview(preview, context.stdout);
          return options.yes ? 'approve' : confirmAdd(release.slug, streams, signal);
        },
        signal,
      ),
    options.yes,
  ).finally(() => telemetry.flush());
  showPackageResult(result, `Установлен пакет ${release.slug}@${release.version}.`, context.stdout);
}
