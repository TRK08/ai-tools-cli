import { parseAgents } from '@/agents';
import { Installer } from '@/installer';
import { isRegistrySlug } from '@/registry';
import { Telemetry } from '@/telemetry';
import { promptStreams } from '@/cli/context';
import type { CliContext, MutationOptions } from '@/cli/types';
import { chooseAll, confirmChanges, showPackagePreview } from '@/cli/ui/package-ui';
import { requireMutationTty, selectScope } from './selection';

/**
 * Выбирает область для чтения lock; Installer проверяет её registry до меню обновлений.
 * Показывает единый preview и выводит независимые ошибки пакетов.
 */
export async function updateSkills(
  context: CliContext,
  slug: string | undefined,
  options: MutationOptions,
): Promise<void> {
  const streams = promptStreams(context);
  requireMutationTty(streams, options.yes);
  if (slug && !isRegistrySlug(slug)) throw new Error('Укажите slug установленного пакета.');
  if (!slug && options.skill.length) throw new Error('Для --skill укажите пакет.');
  const agents = parseAgents(options.agent);
  const scope = await selectScope(options, context.runtime, streams);
  if (scope === null) {
    context.stdout.write('Отменено.\n');
    return;
  }
  const telemetry = new Telemetry(context.runtime, { disabled: !!options.withoutStat });
  const installer = new Installer(context.runtime, { scope, telemetry });
  const result = await installer
    .update({ ...(slug && { slug }), agents, skills: options.skill }, async (previews) => {
      const chosen =
        slug || options.yes
          ? previews.map((item) => item.slug)
          : await chooseAll(
              'Выберите пакеты для обновления',
              previews.map((item) => ({
                value: item.slug,
                label: item.slug,
                hint: `${item.previousVersion} → ${item.version}`,
              })),
              streams,
            );
      if (chosen === null) return null;
      for (const preview of previews)
        if (chosen.includes(preview.slug)) showPackagePreview(preview, context.stdout);
      const decision = await confirmChanges('Применить обновления?', streams, options.yes);
      return decision === 'approve' ? chosen : decision === 'decline' ? [] : null;
    })
    .finally(() => telemetry.flush());
  for (const name of result.updated) context.stdout.write(`Обновлён пакет ${name}.\n`);
  if (result.cancelled) context.stdout.write('Отменено.\n');
  else if (!result.updated.length && !result.failures.length)
    context.stdout.write('Без изменений.\n');
  if (result.failures.length)
    throw new Error(result.failures.map((item) => `${item.slug} — ${item.error}`).join('\n'));
}
