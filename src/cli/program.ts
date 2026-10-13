import { Command } from 'commander';
import { parseAgents } from '../installer/agents.ts';
import { LocalInstaller, type LocalChange } from '../installer/local.ts';
import type { InstallationScope } from '../installer/types.ts';
import type { RuntimeContext } from '../runtime.ts';
import { selectAgents, type PromptStreams } from './agents-prompt.ts';

export interface CliOutput {
  readonly write: (message: string) => void;
}

export function createProgram(
  version: string,
  context: RuntimeContext,
  output: CliOutput,
  streams: PromptStreams = { input: process.stdin, output: process.stdout },
): Command {
  const program = new Command();
  program
    .name('skills-installer')
    .description(
      'Install and manage local skill directories for five agents in project or global scope.',
    )
    .version(version)
    .allowExcessArguments(false)
    .action(() => {
      program.outputHelp();
    });
  const collectAgent = (agent: string, previous: string[]) => [...previous, agent];
  const scopeOf = (options: { global?: boolean }): InstallationScope =>
    options.global ? 'global' : 'project';
  const installer = (options: { global?: boolean }) =>
    new LocalInstaller(context, { scope: scopeOf(options), report: output.write });
  const checkResult = (result: LocalChange) => {
    if (result.status === 'partial' || result.status === 'failed')
      throw new Error(`${result.status}: ${result.errors.join('; ')}`);
  };
  const agentHelp = 'claude-code, codex, opencode, pi, cursor; repeatable';

  program
    .command('add')
    .description('Add a local skill directory; select agents interactively without -a')
    .argument('<source>', 'local directory containing SKILL.md')
    .option('-a, --agent <agent>', agentHelp, collectAgent, [])
    .option('-g, --global', 'use global scope')
    .option('--force', 'replace modified managed contents')
    .action(
      async (source: string, options: { agent: string[]; global?: boolean; force?: boolean }) => {
        const agents = await selectAgents(options.agent, context, scopeOf(options), streams);
        if (agents === null) {
          output.write('Cancelled.');
          return;
        }
        const result = await installer(options).add(source, options.force, agents);
        if (result.status !== 'failed')
          output.write(
            result.status === 'partial'
              ? `Partially added ${result.name}.`
              : `${result.status === 'unchanged' ? 'Unchanged' : 'Added'} ${result.name} (${agents.join(', ')}).`,
          );
        checkResult(result);
      },
    );

  program
    .command('list')
    .description('List registered skills, sources, policies and connections')
    .option('-a, --agent <agent>', agentHelp, collectAgent, [])
    .option('-g, --global', 'use global scope')
    .action(async (options: { agent: string[]; global?: boolean }) => {
      const agents = parseAgents(options.agent);
      const records = await installer(options).list(agents);
      if (!records.length)
        output.write(
          `No skills installed in ${scopeOf(options) === 'project' ? 'this project' : 'global scope'}.`,
        );
      for (const record of records) {
        const source =
          record.source.kind === 'registry'
            ? `${record.source.registryUrl}/${record.source.slug}`
            : record.source.path;
        output.write(
          `${record.name}\t${record.version ?? 'local'}\t${record.policy}\t${source}\t${record.agents.join(', ')}\t${record.connections.map((item) => `${item.agent}: ${item.path}`).join(', ')}`,
        );
      }
    });

  program
    .command('remove')
    .description('Remove selected registered connections, or all without -a')
    .argument('<name>', 'installed skill name')
    .option('-a, --agent <agent>', agentHelp, collectAgent, [])
    .option('-g, --global', 'use global scope')
    .action(async (name: string, options: { agent: string[]; global?: boolean }) => {
      const agents = parseAgents(options.agent);
      const result = await installer(options).remove(name, agents);
      if (result.status !== 'failed')
        output.write(
          result.status === 'unchanged'
            ? `${name} has no matching installation.`
            : result.status === 'partial'
              ? `Partially removed ${name}.`
              : `Removed ${name}${agents.length ? ` (${agents.join(', ')})` : ''}.`,
        );
      checkResult(result);
    });
  return program;
}
