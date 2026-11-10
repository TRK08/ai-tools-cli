import { resolveRegistryUrl } from '@/config';
import { parseAgents } from '@/agents';
import { RegistryClient } from '@/registry';
import { renderSearch } from '@/cli/ui/discovery-ui';
import { selectRegistrySkill } from '@/cli/ui/find-ui';
import { canSearchQuery, RegistryFindSearch } from '@/cli/find-search';
import { promptStreams, scopeOf } from '@/cli/context';
import type { FindOptions, CliContext } from '@/cli/types';
import { addSkill } from './add';

/** Выводит до 10 популярных результатов либо передаёт выбор в add с проверкой точного релиза до меню. */
export async function findSkill(
  context: CliContext,
  input: string | undefined,
  options: FindOptions,
): Promise<void> {
  const streams = promptStreams(context);
  scopeOf(options);
  const agents = parseAgents(options.agent);
  const query = input ?? '';
  const interactive = streams.input.isTTY && streams.output.isTTY && !options.yes;
  if (!interactive && !canSearchQuery(query))
    throw new Error(
      'Для find без диалогов укажите поисковый запрос минимум из 3 символов после trim.',
    );
  const client = new RegistryClient(
    await resolveRegistryUrl(options.registry, context.runtime),
    context.runtime.http,
  );
  if (!interactive) {
    const flags = [
      ...(options.global ? ['-g'] : options.project ? ['-p'] : []),
      ...(agents.length ? agents : ['codex']).flatMap((agent) => ['-a', agent]),
      '-y',
    ];
    renderSearch(
      await client.listSkills(query.trim(), context.runtime.signal),
      client.registryUrl,
      flags,
      streams.output,
    );
    return;
  }
  const selected = await selectRegistrySkill(
    (changed) => new RegistryFindSearch(client, changed),
    query,
    streams,
  );
  if (selected === null) {
    context.stdout.write('Отменено.\n');
    return;
  }
  await addSkill(context, `${selected.packageSlug}@${selected.version}`, {
    ...options,
    registry: client.registryUrl,
    skill: [selected.name],
  });
}
