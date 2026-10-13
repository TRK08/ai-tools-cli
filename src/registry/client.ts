import { createHash } from 'node:crypto';
import type { HttpTransport } from '../runtime.ts';
import { RegistryError } from './errors.ts';
import {
  validateCatalog,
  validateSkillDetail,
  type CatalogSkill,
  type SkillDetail,
} from './catalog.ts';
import {
  getRegistryUrl,
  isFullSemVer,
  isRegistrySlug,
  type RegistryReference,
} from './reference.ts';

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;

/** Временный URL существует только в ответе и не входит в постоянную идентичность установки. */
export interface RegistryArtifact {
  readonly slug: string;
  readonly version: string;
  readonly sha256: string;
  readonly size: number;
  readonly format: 'tar.gz';
  readonly url: string;
  readonly expiresAt: string;
}

export interface RegistryDownload {
  readonly registryUrl: string;
  readonly slug: string;
  readonly version: string;
  readonly archiveHash: string;
  readonly size: number;
}

export interface RegistryClientOptions {
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * Читает тело HTTP-ответа в память с проверкой фактического числа байтов. В finally отменяет оставшееся
 * чтение и освобождает reader; превышение лимита даёт INVALID_RESPONSE.
 */
async function readBounded(response: Response, maximum: number): Promise<Buffer> {
  if (!response.body)
    throw new RegistryError('INVALID_RESPONSE', 'В HTTP-ответе отсутствует тело.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum)
        throw new RegistryError('INVALID_RESPONSE', 'Размер HTTP-ответа превышает ограничение.');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Проверяет идентичность, версию, digest, размер, формат и временный URL артефакта. Возвращает
 * неизменяемые метаданные; срок действия отдельно проверяется при скачивании.
 */
function validateArtifact(value: unknown, reference: RegistryReference): RegistryArtifact {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new RegistryError('INVALID_RESPONSE', 'Реестр вернул некорректные метаданные артефакта.');
  const data = value as Record<string, unknown>;
  if (
    data.slug !== reference.slug ||
    typeof data.version !== 'string' ||
    !isFullSemVer(data.version) ||
    (reference.version !== undefined && data.version !== reference.version) ||
    typeof data.sha256 !== 'string' ||
    data.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(data.sha256) ||
    typeof data.size !== 'number' ||
    !Number.isSafeInteger(data.size) ||
    data.size <= 0 ||
    data.size > MAX_ARTIFACT_BYTES ||
    data.format !== 'tar.gz' ||
    typeof data.expiresAt !== 'string' ||
    /\p{Cc}/u.test(data.expiresAt) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(data.expiresAt) ||
    !Number.isFinite(Date.parse(data.expiresAt)) ||
    typeof data.url !== 'string'
  )
    throw new RegistryError(
      'INVALID_RESPONSE',
      'Реестр вернул некорректные данные артефакта (slug, версия, SHA-256, размер, формат или срок действия).',
    );
  try {
    const url = new URL(data.url);
    if (
      /\p{Cc}/u.test(data.url) ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('Некорректный URL.');
  } catch (cause) {
    throw new RegistryError(
      'INVALID_RESPONSE',
      'Реестр вернул некорректный URL скачивания артефакта.',
      { cause },
    );
  }
  return Object.freeze({
    slug: reference.slug,
    version: data.version,
    sha256: data.sha256,
    size: data.size,
    format: 'tar.gz',
    url: data.url,
    expiresAt: data.expiresAt,
  });
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

  /**
   * Разрешает latest или явно указанную полную версию до подтверждения установки.
   *
   * @returns Проверенные метаданные выбранного артефакта с временным URL.
   * @remarks signal отменяет запрос метаданных; ошибки и отмена пробрасываются как RegistryError.
   */
  async resolveArtifact(
    reference: RegistryReference,
    signal?: AbortSignal,
  ): Promise<RegistryArtifact> {
    if (
      !isRegistrySlug(reference.slug) ||
      (reference.version !== undefined && !isFullSemVer(reference.version))
    )
      throw new RegistryError(
        'INVALID_REFERENCE',
        'Некорректный slug реестра или полная версия SemVer.',
      );
    const url = new URL(
      `${this.registryUrl}/api/v1/skills/${encodeURIComponent(reference.slug)}/artifact`,
    );
    if (reference.version !== undefined) url.searchParams.set('version', reference.version);
    const missing =
      reference.version === undefined
        ? `Скилл ${reference.slug}`
        : `Скилл ${reference.slug}@${reference.version}`;
    return validateArtifact(
      await this.requestJson(url, MAX_METADATA_BYTES, missing, signal),
      reference,
    );
  }

  /**
   * Получает каталог с буквальным серверным slugPrefix; локальную фильтрацию не выполняет. Ошибки
   * API/валидации пробрасываются и не заменяются пустым списком.
   */
  async listSkills(slugPrefix?: string, signal?: AbortSignal): Promise<readonly CatalogSkill[]> {
    const url = new URL(`${this.registryUrl}/api/v1/skills`);
    if (slugPrefix !== undefined) url.searchParams.set('slugPrefix', slugPrefix);
    return validateCatalog(await this.requestJson(url, 8 * 1024 * 1024, 'Каталог', signal));
  }

  /** Получает и проверяет карточку slug для указанной версии либо текущей версии registry. */
  async getSkill(slug: string, version?: string, signal?: AbortSignal): Promise<SkillDetail> {
    if (!isRegistrySlug(slug) || (version !== undefined && !isFullSemVer(version)))
      throw new RegistryError(
        'INVALID_REFERENCE',
        'Для карточки скилла нужен slug реестра; при указании версии требуется полная версия SemVer.',
      );
    const url = new URL(`${this.registryUrl}/api/v1/skills/${encodeURIComponent(slug)}`);
    if (version !== undefined) url.searchParams.set('version', version);
    return validateSkillDetail(
      await this.requestJson(url, 4 * 1024 * 1024, `Скилл ${slug}`, signal),
      slug,
      version,
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
    try {
      const response = await this.http(url, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
        credentials: 'omit',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new RegistryError(
          response.status === 404 ? 'NOT_FOUND' : 'REGISTRY_UNAVAILABLE',
          response.status === 404
            ? `${missing} не найден (HTTP 404: скилл или версия не найдены).`
            : `Реестр недоступен (HTTP ${response.status}${response.status === 503 ? ': сервис временно недоступен' : ''}).`,
          undefined,
          response.status,
        );
      }
      const bytes = await readBounded(response, maximum);
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      } catch {
        throw new RegistryError('INVALID_RESPONSE', 'Реестр вернул некорректный JSON.');
      }
    } catch (cause) {
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

  /**
   * Скачивает выбранный артефакт и проверяет размер и SHA-256 до передачи адаптеру.
   *
   * @remarks Истёкший URL или ответ 401/403 обновляются один раз для той же версии; смена digest/размера
   * отклоняется.
   * @returns Байты архива и постоянные данные download без подписанного URL.
   */
  async downloadArtifact(
    original: RegistryArtifact,
  ): Promise<{ readonly bytes: Buffer; readonly download: RegistryDownload }> {
    const selected = validateArtifact(original, { slug: original.slug, version: original.version });
    let artifact = selected;
    let refreshed = false;
    /** Обновляет URL той же версии, проверяя неизменность digest/размера и новый срок действия. */
    const refresh = async () => {
      refreshed = true;
      const fresh = await this.resolveArtifact({ slug: selected.slug, version: selected.version });
      if (fresh.sha256 !== selected.sha256 || fresh.size !== selected.size)
        throw new RegistryError(
          'ARTIFACT_MISMATCH',
          'Данные артефакта в реестре изменились при обновлении URL скачивания.',
        );
      if (Date.parse(fresh.expiresAt) <= this.now())
        throw new RegistryError(
          'URL_EXPIRED',
          'После обновления реестр вернул URL скачивания с истёкшим сроком действия.',
        );
      return fresh;
    };
    if (Date.parse(artifact.expiresAt) <= this.now()) artifact = await refresh();
    let bytes: Buffer;
    try {
      bytes = await this.download(artifact);
    } catch (cause) {
      if (refreshed || !(cause instanceof RegistryError) || ![401, 403].includes(cause.status ?? 0))
        throw cause;
      artifact = await refresh();
      bytes = await this.download(artifact);
    }
    return {
      bytes,
      download: Object.freeze({
        registryUrl: this.registryUrl,
        slug: selected.slug,
        version: selected.version,
        archiveHash: selected.sha256,
        size: bytes.length,
      }),
    };
  }

  /** Читает архив с тайм-аутом и лимитом; несоответствие размера/digest даёт ARTIFACT_MISMATCH. */
  private async download(artifact: RegistryArtifact): Promise<Buffer> {
    try {
      const response = await this.http(artifact.url, {
        signal: AbortSignal.timeout(this.timeoutMs),
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
      const bytes = await readBounded(response, MAX_ARTIFACT_BYTES);
      if (bytes.length !== artifact.size)
        throw new RegistryError(
          'ARTIFACT_MISMATCH',
          'Размер артефакта не соответствует метаданным реестра.',
        );
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
        throw new RegistryError(
          'ARTIFACT_MISMATCH',
          'SHA-256 артефакта не соответствует метаданным реестра.',
        );
      return bytes;
    } catch (cause) {
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
