import { randomUUID } from 'node:crypto';
import type { RuntimeContext } from '@/runtime';

export interface RegistryEventContext {
  readonly registryUrl: string;
  readonly slug: string;
  readonly version: string;
  readonly components: readonly string[];
}

interface PackageEvent {
  readonly eventId: string;
  readonly event: 'download' | 'install';
  readonly version: string;
  readonly components: readonly { readonly kind: 'skill'; readonly name: string }[];
}

export interface TelemetryOptions {
  readonly disabled?: boolean;
  readonly timeoutMs?: number;
}

/** Ограниченная по времени отправка в памяти; не пишет состояние и не меняет результат установки. */
export class Telemetry {
  private readonly pending: Promise<void>[] = [];
  /** Создаёт список отправок в памяти с заданными окружением и тайм-аутом. */
  constructor(
    private readonly runtime: RuntimeContext,
    private readonly options: TelemetryOptions = {},
  ) {}

  /**
   * Формирует registry-событие и запускает фоновую отправку, учитывая отключение статистики. Неверный
   * endpoint и сбои отправки не меняют результат операции; данные на диск не записываются.
   */
  emit(event: 'download' | 'install', input: RegistryEventContext): void {
    if (
      input.components.length === 0 ||
      this.options.disabled ||
      this.runtime.env.DISABLE_TELEMETRY ||
      this.runtime.env.DO_NOT_TRACK
    )
      return;
    try {
      const endpoint = new URL(`${input.registryUrl}/api/v1/packages/${input.slug}/events`);
      const payload: PackageEvent = {
        eventId: randomUUID(),
        event,
        version: input.version,
        components: [...new Set(input.components)].map((name) => ({ kind: 'skill', name })),
      };
      this.pending.push(this.post(endpoint, payload));
    } catch {
      /* Необязательная статистика не должна завершать установку ошибкой. */
    }
  }

  /**
   * Отправляет JSON с ограниченным ожиданием, по тайм-ауту вызывает abort. Закрывает тело ответа и
   * подавляет транспортные ошибки, включая отмену.
   */
  private async post(endpoint: URL, payload: PackageEvent): Promise<void> {
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
      /* Транспортные ошибки, включая отмену, намеренно игнорируются. */
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ожидает текущие накопленные отправки и удаляет их из списка pending. События, добавленные после
   * начала ожидания, остаются для следующего flush.
   */
  async flush(): Promise<void> {
    await Promise.all(this.pending.splice(0));
  }
}
