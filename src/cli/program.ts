import { Command } from 'commander';

export function createProgram(version: string): Command {
  const program = new Command();

  program
    .name('skills-installer')
    .description('Install and manage agent skills. Foundation: help and version are available.')
    .version(version)
    .allowExcessArguments(false)
    .action(() => {
      program.outputHelp();
    });

  return program;
}
