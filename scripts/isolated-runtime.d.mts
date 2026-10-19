export interface IsolatedRuntime {
  readonly temporaryRoot: string;
  readonly roots: { readonly cwd: string; readonly home: string };
  readonly env: Record<string, string>;
}

/** Собирает безопасный env; изолированные пути побеждают overrides без учёта регистра. */
export function isolatedEnvironment(
  root: string,
  overrides?: Record<string, string | undefined>,
  ambient?: NodeJS.ProcessEnv,
): Record<string, string>;

/** Создаёт каталоги и npmrc внутри root; очисткой владеет вызывающий. */
export function prepareIsolatedRuntime(
  root: string,
  overrides?: Record<string, string>,
): Promise<Pick<IsolatedRuntime, 'roots' | 'env'>>;

/** Изолирует runtime callback и удаляет собственный root с ограниченными retry. */
export function withIsolatedRuntime<T>(
  run: (runtime: IsolatedRuntime) => Promise<T>,
  overrides?: Record<string, string>,
): Promise<T>;
