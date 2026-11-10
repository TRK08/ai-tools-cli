import { createHash } from 'node:crypto';
import type { HttpTransport } from '@/runtime';
import { RegistryError } from './errors';
import {
  archiveIdentity,
  invalidResponse,
  MAX_ARCHIVE_BYTES,
  registryObject,
  validateCatalog,
  validateRelease,
  type CatalogPage,
  type CatalogSkill,
  type PackageRelease,
} from './catalog';
import { getRegistryUrl, isFullSemVer, isRegistrySlug, type RegistryReference } from './reference';

/** Подписанный URL существует только на время загрузки выбранного компонента. */
interface RegistryArtifact {
  readonly url: string;
  readonly expiresAt: string;
}

export interface RegistryClientOptions {
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * Читает тело HTTP-ответа в память с проверкой фактического числа байтов. В finally отменяет оставшееся
 * чтение и освобождает reader; превышение лимита даёт INVALID_RESPONSE.
 */
async function readBounded(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!response.body)
    throw new RegistryError('INVALID_RESPONSE', 'В HTTP-ответе отсутствует тело.');
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maximum)
        throw new RegistryError('INVALID_RESPONSE', 'Размер HTTP-ответа превышает ограничение.');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Сверяет идентичность и ZIP с выбранным релизом и проверяет подписанный URL. */
function validateArtifact(value: unknown, selected: CatalogSkill): RegistryArtifact {
  const { packageSlug, kind, name, version, url, expiresAt } = registryObject(value);
  const { size, sha256 } = archiveIdentity(value);
  if (
    packageSlug !== selected.packageSlug ||
    kind !== 'skill' ||
    name !== selected.name ||
    version !== selected.version ||
    size !== selected.size ||
    sha256 !== selected.sha256
  )
    throw new RegistryError(
      'ARTIFACT_MISMATCH',
      'Артефакт не соответствует скиллу выбранного релиза.',
    );
  if (
    typeof expiresAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(expiresAt) ||
    /\p{Cc}/u.test(expiresAt) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    typeof url !== 'string' ||
    /\p{Cc}/u.test(url)
  )
    invalidResponse('неверный URL или срок действия артефакта');
  try {
    const parsed = new URL(url);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      invalidResponse('небезопасный URL скачивания');
  } catch {
    invalidResponse('некорректный URL скачивания');
  }
  return { url, expiresAt };
}

/** Независимый от UI клиент: разрешение метаданных отделено от проверенного скачивания. */
export class RegistryClient {
  readonly registryUrl: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  /** Проверяет базовый URL и задаёт подменяемый HTTP, часы и тайм-аут; запросов не выполняет. */
  constructor(
    registryUrl: string,
    private readonly http: HttpTransport,
    options: RegistryClientOptions = {},
  ) {
    this.registryUrl = getRegistryUrl(registryUrl, {});
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /** Получает текущий или точный релиз пакета, не запрашивая подписанных URL. */
  async getPackage(reference: RegistryReference, signal?: AbortSignal): Promise<PackageRelease> {
    if (
      !isRegistrySlug(reference.slug) ||
      (reference.version !== undefined && !isFullSemVer(reference.version))
    )
      throw new RegistryError(
        'INVALID_REFERENCE',
        'Некорректный slug пакета или полная версия SemVer.',
      );
    const url = new URL(`${this.registryUrl}/api/v1/packages/${reference.slug}`);
    if (reference.version !== undefined) url.searchParams.set('version', reference.version);
    return validateRelease(
      await this.requestJson(
        url,
        4 * 1024 * 1024,
        `Пакет ${reference.slug}${reference.version ? '@' + reference.version : ''}`,
        signal,
      ),
      reference,
    );
  }

  /** Запрашивает одну страницу с фиксированными sort=popular и limit=10, сохраняя серверный порядок и total. */
  async listSkills(query: string, signal?: AbortSignal): Promise<CatalogPage> {
    const url = new URL(`${this.registryUrl}/api/v1/components`);
    url.searchParams.set('kind', 'skill');
    url.searchParams.set('q', query);
    url.searchParams.set('sort', 'popular');
    url.searchParams.set('limit', '10');
    return validateCatalog(await this.requestJson(url, 8 * 1024 * 1024, 'Каталог', signal));
  }

  /** Запрашивает подписанный URL только для точной выбранной версии и сверяет его метаданные. */
  private async resolveArtifact(
    selected: CatalogSkill,
    signal?: AbortSignal,
  ): Promise<RegistryArtifact> {
    const url = new URL(
      `${this.registryUrl}/api/v1/packages/${selected.packageSlug}/components/skill/${selected.name}/artifact`,
    );
    url.searchParams.set('version', selected.version);
    return validateArtifact(
      await this.requestJson(
        url,
        64 * 1024,
        `Скилл ${selected.packageSlug}/${selected.name}`,
        signal,
      ),
      selected,
    );
  }

  /**
   * Запрашивает ограниченное JSON-тело с общим тайм-аутом и необязательным сигналом отмены. Проверяет
   * HTTP-статус и строгий UTF-8; закрывает неиспользуемое тело ответа.
   */
  private async requestJson(
    url: URL,
    maximum: number,
    missing: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs);
      requestSignal.throwIfAborted();
      const response = await this.http(url, {
        signal: requestSignal,
        redirect: 'error',
        credentials: 'omit',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new RegistryError(
          response.status === 404 ? 'NOT_FOUND' : 'REGISTRY_UNAVAILABLE',
          response.status === 404
            ? `${missing} не найден (HTTP 404).`
            : `Ошибка реестра (HTTP ${response.status}${response.status === 410 ? ': релиз заблокирован' : ''}).`,
          undefined,
          response.status,
        );
      }
      const bytes = await readBounded(response, maximum, requestSignal);
      signal?.throwIfAborted();
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      } catch {
        throw new RegistryError('INVALID_RESPONSE', 'Реестр вернул некорректный JSON.');
      }
    } catch (cause) {
      signal?.throwIfAborted();
      if (cause instanceof RegistryError) throw cause;
      throw new RegistryError(
        'REGISTRY_UNAVAILABLE',
        'Запрос к реестру завершился ошибкой или превысил время ожидания.',
        {
          cause,
        },
      );
    }
  }

  /** Скачивает точный ZIP. Истёкший URL или HTTP 401/403 допускают одно обновление ссылки. */
  async downloadArtifact(selected: CatalogSkill, signal?: AbortSignal): Promise<Buffer> {
    let artifact = await this.resolveArtifact(selected, signal);
    const expired = () => Date.parse(artifact.expiresAt) <= this.now();
    if (!expired()) {
      try {
        return await this.download(artifact.url, selected, signal);
      } catch (cause) {
        if (!(cause instanceof RegistryError) || ![401, 403].includes(cause.status ?? 0))
          throw cause;
      }
    }
    artifact = await this.resolveArtifact(selected, signal);
    if (expired())
      throw new RegistryError('URL_EXPIRED', 'Реестр вернул просроченный URL скачивания.');
    return this.download(artifact.url, selected, signal);
  }

  /** Читает архив с тайм-аутом и лимитом; несоответствие размера/digest даёт ARTIFACT_MISMATCH. */
  private async download(
    url: string,
    selected: CatalogSkill,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs);
      requestSignal.throwIfAborted();
      const response = await this.http(url, {
        signal: requestSignal,
        redirect: 'error',
        credentials: 'omit',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new RegistryError(
          'DOWNLOAD_FAILED',
          `Не удалось скачать артефакт (HTTP ${response.status}).`,
          undefined,
          response.status,
        );
      }
      const bytes = await readBounded(response, MAX_ARCHIVE_BYTES, requestSignal);
      if (bytes.length !== selected.size)
        throw new RegistryError(
          'ARTIFACT_MISMATCH',
          'Размер артефакта не соответствует метаданным реестра.',
        );
      if (createHash('sha256').update(bytes).digest('hex') !== selected.sha256)
        throw new RegistryError(
          'ARTIFACT_MISMATCH',
          'SHA-256 артефакта не соответствует метаданным реестра.',
        );
      return bytes;
    } catch (cause) {
      signal?.throwIfAborted();
      if (cause instanceof RegistryError) throw cause;
      throw new RegistryError(
        'DOWNLOAD_FAILED',
        'Скачивание артефакта завершилось ошибкой или превысило время ожидания.',
        {
          cause,
        },
      );
    }
  }
}
