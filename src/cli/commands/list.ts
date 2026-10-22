import { parseAgents } from '@/agents';
import { Installer } from '@/installer';
import { createLoading } from '@/cli/terminal';
import { renderSkillList } from '@/cli/ui/list-ui';
import { promptStreams, scopeOf } from '@/cli/context';
import type { CliContext, ScopeOptions } from '@/cli/types';

/** Читает собственный lock выбранной области и передаёт готовые записи представлению. */
export async function listSkills(context: CliContext, options: ScopeOptions): Promise<void> {
  const streams = promptStreams(context);
  const agents = parseAgents(options.agent);
  const target = new Installer(context.runtime, { scope: scopeOf(options) });
  const records = await createLoading(streams).run('Чтение установленных скиллов…', () =>
    target.list(agents),
  );
  renderSkillList(records, scopeOf(options), agents, streams);
}
