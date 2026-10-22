import { AGENTS } from '@/agents';
import type { AddPreview } from '@/installer';
import type { SkillDetail } from '@/registry';
import type { AddCardView } from '@/cli/ui/types';

/** Готовит подписи и группы назначений для UI, сохраняя выбранную Installer версию. */
export function addCardView(preview: AddPreview, details?: SkillDetail): AddCardView {
  const destinations = new Map<string, string[]>();
  for (const { agent, path } of preview.destinations) {
    const labels = destinations.get(path) ?? [];
    labels.push(AGENTS.find((item) => item.id === agent)!.label);
    destinations.set(path, labels);
  }
  return {
    name: details?.name ?? preview.name,
    installationName: preview.name,
    ...(preview.source.kind === 'registry' ? { slug: preview.source.slug } : {}),
    version: preview.version,
    source: preview.source.kind === 'registry' ? preview.source.registryUrl : preview.source.path,
    scope:
      preview.scope === 'project' ? 'локальная — текущий проект' : 'глобальная — для пользователя',
    description: details?.shortDescription ?? preview.description ?? '',
    tags: details?.tags ?? [],
    ...(details ? { installCount: details.installCount } : {}),
    sharedDirectory: preview.sharedDirectory,
    destinations: [...destinations].map(([path, agents]) => ({ path, agents })),
  };
}
