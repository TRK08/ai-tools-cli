#!/usr/bin/env node
import packageJson from '../package.json' with { type: 'json' };
import { homedir } from 'node:os';
import { createProgram } from './cli/program.ts';

try {
  await createProgram(
    packageJson.version,
    { roots: { cwd: process.cwd(), home: homedir() }, env: process.env, http: fetch },
    { write: (message) => console.log(message) },
  ).parseAsync();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
