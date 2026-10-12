export interface FileSystemRoots {
  readonly cwd: string;
  readonly home: string;
}

export type Environment = Readonly<Record<string, string | undefined>>;

export type HttpTransport = typeof fetch;

/** Passed to operations explicitly; tests supply isolated roots, env, and HTTP. */
export interface RuntimeContext {
  readonly roots: FileSystemRoots;
  readonly env: Environment;
  readonly http: HttpTransport;
}
