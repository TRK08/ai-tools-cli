import { createHash } from 'node:crypto';
import type { HttpTransport } from '../runtime.ts';
import { RegistryError } from './errors.ts';
import {
  getRegistryUrl,
  isFullSemVer,
  isRegistrySlug,
  type RegistryReference,
} from './reference.ts';

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;

/** Temporary URL lives only in this response, never in installation identity. */
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

async function readBounded(response: Response, maximum: number): Promise<Buffer> {
  if (!response.body) throw new RegistryError('INVALID_RESPONSE', 'HTTP response has no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum)
        throw new RegistryError('INVALID_RESPONSE', 'HTTP response exceeds the size limit.');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function validateArtifact(value: unknown, reference: RegistryReference): RegistryArtifact {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new RegistryError('INVALID_RESPONSE', 'Registry returned invalid artifact metadata.');
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
      'Registry returned invalid artifact identity (slug, version, SHA-256, size, format or expiry).',
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
      throw new Error('Invalid URL.');
  } catch (cause) {
    throw new RegistryError(
      'INVALID_RESPONSE',
      'Registry returned an invalid artifact download URL.',
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

/** UI-free client. Metadata resolution and verified download are separate operations. */
export class RegistryClient {
  readonly registryUrl: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    registryUrl: string,
    private readonly http: HttpTransport,
    options: RegistryClientOptions = {},
  ) {
    this.registryUrl = getRegistryUrl(registryUrl, {});
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  async resolveArtifact(reference: RegistryReference): Promise<RegistryArtifact> {
    if (
      !isRegistrySlug(reference.slug) ||
      (reference.version !== undefined && !isFullSemVer(reference.version))
    )
      throw new RegistryError('INVALID_REFERENCE', 'Invalid registry slug or full SemVer version.');
    const url = new URL(
      `${this.registryUrl}/api/v1/skills/${encodeURIComponent(reference.slug)}/artifact`,
    );
    if (reference.version !== undefined) url.searchParams.set('version', reference.version);
    try {
      const response = await this.http(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
        credentials: 'omit',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const missing =
          reference.version === undefined
            ? `Skill ${reference.slug}`
            : `Skill ${reference.slug}@${reference.version}`;
        throw new RegistryError(
          response.status === 404 ? 'NOT_FOUND' : 'REGISTRY_UNAVAILABLE',
          response.status === 404
            ? `${missing} not found (HTTP 404: skill or version not found).`
            : `Registry unavailable (HTTP ${response.status}${response.status === 503 ? ': service temporarily unavailable' : ''}).`,
          undefined,
          response.status,
        );
      }
      const bytes = await readBounded(response, MAX_METADATA_BYTES);
      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new RegistryError('INVALID_RESPONSE', 'Registry returned invalid JSON.');
      }
      return validateArtifact(data, reference);
    } catch (cause) {
      if (cause instanceof RegistryError) throw cause;
      throw new RegistryError('REGISTRY_UNAVAILABLE', 'Registry request failed or timed out.', {
        cause,
      });
    }
  }

  async downloadArtifact(
    original: RegistryArtifact,
  ): Promise<{ readonly bytes: Buffer; readonly download: RegistryDownload }> {
    const selected = validateArtifact(original, { slug: original.slug, version: original.version });
    let artifact = selected;
    let refreshed = false;
    const refresh = async () => {
      refreshed = true;
      const fresh = await this.resolveArtifact({ slug: selected.slug, version: selected.version });
      if (fresh.sha256 !== selected.sha256 || fresh.size !== selected.size)
        throw new RegistryError(
          'ARTIFACT_MISMATCH',
          'Registry artifact identity changed while refreshing its download URL.',
        );
      if (Date.parse(fresh.expiresAt) <= this.now())
        throw new RegistryError(
          'URL_EXPIRED',
          'Registry returned an expired download URL after refresh.',
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
          `Artifact download failed (HTTP ${response.status}).`,
          undefined,
          response.status,
        );
      }
      const bytes = await readBounded(response, MAX_ARTIFACT_BYTES);
      if (bytes.length !== artifact.size)
        throw new RegistryError(
          'ARTIFACT_MISMATCH',
          'Artifact size does not match registry metadata.',
        );
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
        throw new RegistryError(
          'ARTIFACT_MISMATCH',
          'Artifact SHA-256 does not match registry metadata.',
        );
      return bytes;
    } catch (cause) {
      if (cause instanceof RegistryError) throw cause;
      throw new RegistryError('DOWNLOAD_FAILED', 'Artifact download failed or timed out.', {
        cause,
      });
    }
  }
}
