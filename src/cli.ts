#!/usr/bin/env node
/** Создаёт единственный контекст с реальными cwd/home/env/HTTP и потоками процесса. */
import packageJson from '../package.json' with { type: 'json' };
import { homedir } from 'node:os';
import { executeCli } from '@/cli/run';

process.exitCode = await executeCli(
  {
    version: packageJson.version,
    runtime: { roots: { cwd: process.cwd(), home: homedir() }, env: process.env, http: fetch },
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
  process.argv.slice(2),
);
