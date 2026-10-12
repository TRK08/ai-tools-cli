import { Command } from 'commander';
import { LocalInstaller } from '../installer/local.ts';
import type { RuntimeContext } from '../runtime.ts';

export interface CliOutput {
  readonly write: (message: string) => void;
}

export function createProgram(
  version: string,
  context: RuntimeContext,
  output: CliOutput,
): Command {
  const program = new Command();

  program
    .name('skills-installer')
    .description(
      'Install and manage agent skills. Currently: project directories for explicit Codex.',
    )
    .version(version)
    .allowExcessArguments(false)
    .action(() => {
      program.outputHelp();
    });

  const installer = () => new LocalInstaller(context, { report: output.write });
  const collectAgent = (agent: string, previous: string[]) => [...previous, agent];
  const checkAgents = (agents: readonly string[], required: boolean) => {
    if (required && agents.length === 0) {
      throw new Error('Agent selection is not available yet; specify -a codex.');
    }
    if (agents.some((agent) => agent !== 'codex')) {
      throw new Error('Only Codex is available at this stage; specify -a codex.');
    }
  };

  program
    .command('add')
    .description('Add a local skill directory to this project for Codex')
    .argument('<source>', 'local directory containing SKILL.md')
    .option('-a, --agent <agent>', 'agent (currently codex); repeatable', collectAgent, [])
    .option('--force', 'replace modified managed contents')
    .action(async (source: string, options: { agent: string[]; force?: boolean }) => {
      checkAgents(options.agent, true);
      const result = await installer().add(source, options.force);
      output.write(
        `${result.status === 'unchanged' ? 'Unchanged' : 'Added'} ${result.name} (codex).`,
      );
    });

  program
    .command('list')
    .description('List skills registered in this project')
    .option('-a, --agent <agent>', 'filter agent (currently codex)', collectAgent, [])
    .action(async (options: { agent: string[] }) => {
      checkAgents(options.agent, false);
      const records = await installer().list();
      const selected = records.filter(
        (record) => options.agent.length === 0 || record.agents.includes('codex'),
      );
      if (selected.length === 0) output.write('No skills installed in this project.');
      for (const record of selected) {
        output.write(`${record.name}\t${record.version ?? 'local'}\t${record.agents.join(', ')}`);
      }
    });

  program
    .command('remove')
    .description('Remove a registered Codex skill from this project')
    .argument('<name>', 'installed skill name')
    .option('-a, --agent <agent>', 'agent (currently codex)', collectAgent, [])
    .action(async (name: string, options: { agent: string[] }) => {
      checkAgents(options.agent, false);
      const result = await installer().remove(name);
      output.write(
        result.status === 'unchanged' ? `${name} is not installed.` : `Removed ${name} (codex).`,
      );
    });

  return program;
}
