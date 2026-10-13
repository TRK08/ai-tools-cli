import { randomUUID } from 'node:crypto';
import type { AgentId, InstallationScope } from '../installer/types.ts';
import type { RuntimeContext } from '../runtime.ts';

export interface RegistryEventContext {
  readonly registryUrl: string;
  readonly slug: string;
  readonly version?: string;
  readonly operation: 'add' | 'update';
  readonly scope: InstallationScope;
  readonly agents: readonly AgentId[];
}

export interface TelemetryEnvelope {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly event: 'download' | 'install';
  readonly occurredAt: string;
  readonly cliVersion: string;
  readonly skill: {
    readonly name: string;
    readonly sourceType: 'registry';
    readonly source: string;
  };
  readonly context: {
    readonly operation: 'add' | 'update';
    readonly scope: InstallationScope;
    readonly agents: readonly AgentId[];
    readonly version?: string;
    readonly status?: 'success' | 'partial' | 'failed';
  };
}

export interface TelemetryOptions {
  readonly disabled?: boolean;
  readonly timeoutMs?: number;
}

/** In-memory, bounded best-effort delivery; never writes state or changes an operation result. */
export class Telemetry {
  private readonly pending: Promise<void>[] = [];
  constructor(
    private readonly runtime: RuntimeContext,
    private readonly cliVersion: string,
    private readonly options: TelemetryOptions = {},
  ) {}

  emit(
    event: 'download' | 'install',
    input: RegistryEventContext,
    status?: 'success' | 'partial' | 'failed',
  ): void {
    if (
      this.options.disabled ||
      this.runtime.env.DISABLE_TELEMETRY ||
      this.runtime.env.DO_NOT_TRACK
    )
      return;
    try {
      const endpoint = new URL(
        this.runtime.env.SKILLS_TELEMETRY_ENDPOINT?.trim() ||
          `${input.registryUrl}/api/v1/skills/events`,
      );
      if (
        !['http:', 'https:'].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash
      )
        return;
      const payload: TelemetryEnvelope = {
        schemaVersion: 1,
        eventId: randomUUID(),
        event,
        occurredAt: new Date().toISOString(),
        cliVersion: this.cliVersion,
        skill: { name: input.slug, sourceType: 'registry', source: input.registryUrl },
        context: {
          operation: input.operation,
          scope: input.scope,
          agents: [...input.agents],
          ...(input.version === undefined ? {} : { version: input.version }),
          ...(status === undefined ? {} : { status }),
        },
      };
      this.pending.push(this.post(endpoint, payload));
    } catch {
      /* Optional statistics cannot fail an installation. */
    }
  }

  private async post(endpoint: URL, payload: TelemetryEnvelope): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve();
      }, this.options.timeoutMs ?? 1000);
    });
    try {
      await Promise.race([
        this.runtime
          .http(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
            redirect: 'error',
            credentials: 'omit',
          })
          .then(async (response) => {
            await response.body?.cancel();
          })
          .catch(() => {}),
        timeout,
      ]);
    } catch {
      /* Transport failures, including abort, are intentionally ignored. */
    } finally {
      clearTimeout(timer);
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.pending.splice(0));
  }
}
