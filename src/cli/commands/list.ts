import { parseAgents } from '@/agents';
import { Installer } from '@/installer';
import { scopeOf } from '@/cli/context';
import type { CliContext, ScopeOptions } from '@/cli/types';

/** Читает и показывает пакеты из lock. Фильтр оставляет скиллы с указанными агентами. */
export async function listSkills(context: CliContext, options: ScopeOptions): Promise<void> {
  const agents = parseAgents(options.agent);
  const installer = new Installer(context.runtime, { scope: scopeOf(options) });
  const lines: string[] = [];
  for (const pkg of await installer.list()) {
    const skills = pkg.skills.filter(
      (skill) => !agents.length || skill.connections.some((item) => agents.includes(item.agent)),
    );
    if (!skills.length) continue;
    lines.push(`${pkg.slug}  ${pkg.version}`);
    const width = Math.max(...skills.map((skill) => skill.name.length));
    for (const skill of skills)
      lines.push(
        `  ${skill.name.padEnd(width)}  ${skill.connections.map((item) => item.agent).join(', ')}`,
      );
  }
  context.stdout.write(lines.length ? lines.join('\n') + '\n' : 'Установленных пакетов нет.\n');
}
