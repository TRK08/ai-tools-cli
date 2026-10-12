import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HttpTransport, RuntimeContext } from '../../src/runtime.js';

export interface TestEnvironment extends RuntimeContext {
  readonly temporaryRoot: string;
}

interface TestEnvironmentOptions {
  readonly env?: Record<string, string>;
  readonly http?: HttpTransport;
}

const blockedHttp: HttpTransport = async () => {
  throw new Error('HTTP requests are disabled in tests; inject a transport explicitly.');
};

export async function withTestEnvironment<T>(
  run: (fixture: TestEnvironment) => Promise<T>,
  options: TestEnvironmentOptions = {},
): Promise<T> {
  const createdRoot = await mkdtemp(join(tmpdir(), 'skills-installer-test-'));

  try {
    const temporaryRoot = await realpath(createdRoot);
    const roots = Object.freeze({
      cwd: join(temporaryRoot, 'project'),
      home: join(temporaryRoot, 'home'),
    });
    const isolatedPaths = {
      HOME: roots.home,
      USERPROFILE: roots.home,
      CLAUDE_CONFIG_DIR: join(roots.home, '.claude'),
      XDG_CONFIG_HOME: join(roots.home, '.config'),
      XDG_DATA_HOME: join(roots.home, '.local', 'share'),
      XDG_STATE_HOME: join(roots.home, '.local', 'state'),
      XDG_CACHE_HOME: join(roots.home, '.cache'),
      CODEX_HOME: join(roots.home, '.codex'),
      TMPDIR: join(temporaryRoot, 'tmp'),
    };
    const env = Object.freeze({
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      ...options.env,
      ...isolatedPaths,
      DISABLE_TELEMETRY: '1',
      DO_NOT_TRACK: '1',
    });

    await Promise.all(
      [roots.cwd, ...new Set(Object.values(isolatedPaths))].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );

    return await run(
      Object.freeze({
        temporaryRoot,
        roots,
        env,
        http: options.http ?? blockedHttp,
      }),
    );
  } finally {
    await rm(createdRoot, { recursive: true, force: true });
  }
}
