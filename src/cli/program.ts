import { Command } from 'commander';
import { parseAgents } from '../installer/agents.ts';
import { LocalInstaller, type LocalChange } from '../installer/local.ts';
import type { InstallationScope } from '../installer/types.ts';
import type { RuntimeContext } from '../runtime.ts';
import { selectAgents, type PromptStreams } from './agents-prompt.ts';
import { createUpdatesUi } from './updates-ui.ts';

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
    .description('Install and manage skills for five agents in project or global scope.')
    .version(version)
    .allowExcessArguments(false)
    .action(() => {
      program.outputHelp();
    });
  const collectAgent = (agent: string, previous: string[]) => [...previous, agent];
  const scopeOf = (options: { global?: boolean }): InstallationScope =>
    options.global ? 'global' : 'project';
  const installer = (options: { global?: boolean; registry?: string }) =>
    new LocalInstaller(context, {
      scope: scopeOf(options),
      report: output.write,
      ...(options.registry === undefined ? {} : { registry: options.registry }),
    });
  const checkResult = (result: LocalChange) => {
    if (result.status === 'partial' || result.status === 'failed')
      throw new Error(`${result.status}: ${result.errors.join('; ')}`);
  };
  const agentHelp = 'claude-code, codex, opencode, pi, cursor; repeatable';

  program
    .command('add')
    .description('Add a directory, archive or registry skill; select agents without -a')
    .argument('<source>', 'local directory, .tar.gz/.tgz, slug or slug@version')
    .option('-a, --agent <agent>', agentHelp, collectAgent, [])
    .option('-g, --global', 'use global scope')
    .option('--force', 'replace modified managed contents')
    .option('--registry <url>', 'registry HTTP(S) base URL (overrides SKILLS_API_URL)')
    .action(
      async (
        source: string,
        options: { agent: string[]; global?: boolean; force?: boolean; registry?: string },
      ) => {
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
    .command('update')
    .description('Update registered skills from saved sources; skip exact versions')
    .argument('[name]', 'installed skill name; all matching skills without a name')
    .option('-a, --agent <agent>', agentHelp, collectAgent, [])
    .option('-g, --global', 'use global scope')
    .option('--force', 'replace modified managed contents; exact versions stay pinned')
    .option('-y, --yes', 'approve updates without prompting (required for changes without TTY)')
    .action(
      async (
        name: string | undefined,
        options: { agent: string[]; global?: boolean; force?: boolean; yes?: boolean },
      ) => {
        const ui = createUpdatesUi(streams, options.yes);
        const result = await new LocalInstaller(context, {
          scope: scopeOf(options),
          report: ui.report,
          reviewUpdate: ui.review,
        }).update(name, options.force, parseAgents(options.agent));
        ui.finish(result);
        if (result.status === 'failed') throw new Error('One or more skills could not be updated.');
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
