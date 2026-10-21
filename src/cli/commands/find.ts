import { parseAgents } from '../../installer/agents.ts';
import type { RegistrySelection } from '../../installer/types.ts';
import { RegistryClient } from '../../registry/client.ts';
import { getRegistryUrl } from '../../registry/reference.ts';
import { sortCatalog } from '../../registry/catalog.ts';
import { renderSearch } from '../ui/discovery-ui.ts';
import { selectRegistrySkill } from '../ui/find-ui.ts';
import { canSearchPrefix, MIN_FIND_PREFIX_LENGTH, RegistryFindSearch } from '../find-search.ts';
import { promptStreams } from '../context.ts';
import type { AddOptions, CliContext } from '../types.ts';
import { addSkill } from './add.ts';

/** Ищет без TTY либо передаёт выбранную registry-версию в общий add с политикой latest. */
export async function findSkill(
  context: CliContext,
  prefix: string | undefined,
  options: AddOptions,
): Promise<void> {
  const streams = promptStreams(context);
  parseAgents(options.agent);
  const query = prefix ?? '';
  const interactive = streams.input.isTTY && streams.output.isTTY;
  if (!interactive && (!query.trim() || !canSearchPrefix(query)))
    throw new Error(
      `Для интерактивного find нужны stdin и stdout терминала (TTY); используйте find <slug-prefix> с префиксом длиной от ${MIN_FIND_PREFIX_LENGTH} символов, чтобы показать результаты без установки.`,
    );
  const client = new RegistryClient(
    getRegistryUrl(options.registry, context.runtime.env),
    context.runtime.http,
  );
  if (!interactive) {
    renderSearch(sortCatalog(await client.listSkills(query)), streams.output);
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
  const reference: RegistrySelection = {
    slug: selected.slug,
    version: selected.currentVersion,
    policy: 'latest',
  };
  context.stdout.write(`Выбран ${selected.slug}@${selected.currentVersion}.\n`);
  await addSkill(
    context,
    `${selected.slug}@${selected.currentVersion}`,
    { ...options, registry: client.registryUrl },
    reference,
  );
}
