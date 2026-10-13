#!/usr/bin/env node
/** Получает реальные cwd/home/env/HTTP, запускает Commander и переводит ошибку команды в код 1. */
import { errorMessage } from './errors.ts';
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
  const message = errorMessage(error);
  console.error(message.startsWith('Ошибка:') ? message : `Ошибка: ${message}`);
  process.exitCode = 1;
}
