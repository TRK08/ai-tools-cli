import type { Environment } from '../runtime.ts';
import { RegistryError } from './errors.ts';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Adapted from ../skills/src/registry-source.ts; full SemVer, including build/prerelease.
const numeric = '(?:0|[1-9][0-9]*)';
const pre = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const versionPattern = new RegExp(
  `^${numeric}\\.${numeric}\\.${numeric}(?:-${pre}(?:\\.${pre})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

export interface RegistryReference {
  readonly slug: string;
  readonly version?: string;
}

export const isRegistrySlug = (value: string) => !/\p{Cc}/u.test(value) && slugPattern.test(value);
export const isFullSemVer = (value: string) => !/\p{Cc}/u.test(value) && versionPattern.test(value);

export function parseRegistryReference(input: string): RegistryReference | null {
  if (/[/:#\\]/.test(input)) return null;
  const [slug, version, extra] = input.split('@');
  if (!slug || !isRegistrySlug(slug) || extra !== undefined) return null;
  if (version !== undefined && !isFullSemVer(version))
    throw new RegistryError(
      'INVALID_REFERENCE',
      'Registry version must be full SemVer without a v prefix.',
    );
  return { slug, ...(version === undefined ? {} : { version }) };
}

export function getRegistryUrl(explicit: string | undefined, env: Environment): string {
  const input = explicit?.trim() || env.SKILLS_API_URL?.trim() || 'http://localhost:8000';
  try {
    const url = new URL(input);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid base URL.');
    return url.href.replace(/\/+$/, '');
  } catch (cause) {
    throw new RegistryError(
      'INVALID_REGISTRY',
      'Registry URL must be an HTTP(S) base URL without credentials, query or fragment.',
      { cause },
    );
  }
}
