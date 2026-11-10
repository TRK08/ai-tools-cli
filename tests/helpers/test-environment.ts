import { withIsolatedRuntime } from '../../scripts/isolated-runtime.ts';

import type { HttpTransport, RuntimeContext } from '@/runtime';

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

/** Изолирует cwd/home/env/npm/tmp теста; HTTP закрыт без явной подмены, root очищается после callback. */
export async function withTestEnvironment<T>(
  run: (fixture: TestEnvironment) => Promise<T>,
  options: TestEnvironmentOptions = {},
): Promise<T> {
  return withIsolatedRuntime(
    async ({ temporaryRoot, roots, env }) =>
      run(
        Object.freeze({
          temporaryRoot,
          roots: Object.freeze(roots),
          env: Object.freeze(env),
          http: options.http ?? blockedHttp,
        }),
      ),
    options.env,
  );
}
