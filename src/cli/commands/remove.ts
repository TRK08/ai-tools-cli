import { AGENTS, parseAgents } from '@/agents';
import { Installer } from '@/installer';
import { isRegistrySlug } from '@/registry';
import { promptStreams } from '@/cli/context';
import type { CliContext, MutationOptions } from '@/cli/types';
import {
  chooseAll,
  confirmChanges,
  showPackagePreview,
  showPackageResult,
} from '@/cli/ui/package-ui';
import { select } from '@/cli/terminal';
import { requireMutationTty, selectScope } from './selection';

/** Выбирает пакет, скиллы и подключения из lock. Подтверждение строится под блокировкой. */
export async function removeSkills(
  context: CliContext,
  slug: string | undefined,
  options: MutationOptions,
): Promise<void> {
  const streams = promptStreams(context);
  requireMutationTty(streams, options.yes);
  if (options.yes && !slug) throw new Error('Для remove --yes укажите имя пакета.');
  if (slug && !isRegistrySlug(slug)) throw new Error('Укажите slug установленного пакета.');
  const explicit = parseAgents(options.agent);
  const scope = await selectScope(options, context.runtime, streams);
  const cancelled = () => showPackageResult(null, '', context.stdout);
  if (scope === null) return cancelled();
  const installer = new Installer(context.runtime, { scope });
  let names = options.skill;
  let agents = explicit;
  if (!options.yes) {
    const packages = await installer.list();
    if (!slug && !packages.length) {
      context.stdout.write('Установленных пакетов нет.\n');
      return;
    }
    if (!slug) {
      const selected = await select({
        ...streams,
        message: 'Выберите пакет',
        options: packages.map((pkg) => ({ value: pkg.slug, label: pkg.slug, hint: pkg.version })),
        initialValue: packages[0]!.slug,
      });
      if (selected === null) return cancelled();
      slug = selected;
    }
    const pkg = packages.find((item) => item.slug === slug);
    if (!pkg) throw new Error(`Пакет ${slug} не установлен.`);
    if (!names.length) {
      const chosen = await chooseAll(
        'Выберите скиллы для удаления',
        pkg.skills.map((item) => ({ value: item.name, label: item.name })),
        streams,
      );
      if (chosen === null) return cancelled();
      names = chosen;
    }
    for (const name of names)
      if (!pkg.skills.some((item) => item.name === name))
        throw new Error(`Скилл ${name} не установлен в пакете ${slug}.`);
    if (!agents.length) {
      const installed = new Set(
        pkg.skills
          .filter((item) => names.includes(item.name))
          .flatMap((item) => item.connections.map((connection) => connection.agent)),
      );
      const chosen = await chooseAll(
        'Выберите подключения для удаления',
        AGENTS.filter((agent) => installed.has(agent.id)).map((agent) => ({
          value: agent.id,
          label: agent.label,
        })),
        streams,
      );
      if (chosen === null) return cancelled();
      agents = chosen;
    }
  }
  const result = await installer.remove(slug!, names, agents, async (preview) => {
    showPackagePreview(preview, context.stdout);
    return confirmChanges(`Удалить выбранные подключения пакета ${slug}?`, streams, options.yes);
  });
  showPackageResult(result, `Подключения пакета ${slug} удалены.`, context.stdout);
}
