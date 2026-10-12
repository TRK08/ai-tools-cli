#!/usr/bin/env node
import packageJson from '../package.json' with { type: 'json' };
import { createProgram } from './cli/program.ts';

createProgram(packageJson.version).parse();
