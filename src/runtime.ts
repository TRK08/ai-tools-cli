export type InstallationScope = 'project' | 'global';

export interface FileSystemRoots {
  readonly cwd: string;
  readonly home: string;
}

export type Environment = Readonly<Record<string, string | undefined>>;

export type HttpTransport = typeof fetch;

/** Явно передаваемые корни, окружение и HTTP; тесты подставляют изолированные зависимости. */
export interface RuntimeContext {
  readonly roots: FileSystemRoots;
  readonly env: Environment;
  readonly http: HttpTransport;
}
