import { parseAgents } from '../../installer/agents.ts';
import { Installer } from '../../installer/installer.ts';
import { createLoading } from '../terminal/loading.ts';
import { renderSkillList } from '../ui/list-ui.ts';
import { promptStreams, scopeOf } from '../context.ts';
import type { CliContext, ScopeOptions } from '../types.ts';

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
