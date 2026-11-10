import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import type { HttpTransport } from '@/runtime';

export interface ZipEntry {
  readonly path: string;
  readonly contents: Buffer;
  readonly mode?: number;
  readonly method?: 0 | 8;
}

/** Формирует настоящий ZIP с UTF-8 путями, Unix modes и обоими методами сжатия core. */
export function zip(entries: readonly ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { path, contents, mode = 0o100644, method = path === 'SKILL.md' ? 8 : 0 } of entries) {
    const name = Buffer.from(path);
    const compressed = method ? deflateRawSync(contents) : contents;
    const entry = Buffer.alloc(30);
    entry.writeUInt32LE(0x04034b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(0x800, 6);
    entry.writeUInt16LE(method, 8);
    entry.writeUInt32LE(crc32(contents), 14);
    entry.writeUInt32LE(compressed.length, 18);
    entry.writeUInt32LE(contents.length, 22);
    entry.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE(0x314, 4);
    entry.copy(header, 6, 4);
    header.writeUInt32LE((mode << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    local.push(entry, name, compressed);
    central.push(header, name);
    offset += entry.length + name.length + compressed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(
    central.reduce((length, part) => length + part.length, 0),
    12,
  );
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

export const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const binaryResource = Buffer.from([0, 255, 128, 13, 10]);

/** Создаёт согласованные ZIP/descriptor/HTTP-метаданные; дефекты вносятся после формирования состава. */
export function registrySkill(
  packageSlug: string,
  name: string,
  version: string,
  options: {
    files?: readonly ZipEntry[];
    descriptorSize?: number;
    mutateManifest?: (manifest: Record<string, unknown>) => void;
    mutateEntries?: (entries: ZipEntry[]) => void;
    mutateZip?: (bytes: Buffer) => void;
    extra?: readonly ZipEntry[];
  } = {},
) {
  const installName = `${packageSlug}-${name}`;
  const files = options.files ?? [
    {
      path: 'SKILL.md',
      contents: Buffer.from(
        `---\nname: ${installName}\ndescription: Test skill\n---\nVersion ${version}\n`,
      ),
    },
    { path: 'scripts/run.sh', contents: Buffer.from('#!/bin/sh\n'), mode: 0o100755 },
    { path: 'references/файл.bin', contents: binaryResource },
  ];
  const manifest = {
    schemaVersion: 1,
    kind: 'skill',
    package: packageSlug,
    version,
    name,
    installName,
    files: files.map((file) => ({
      path: file.path,
      size: file.contents.length,
      mode: (file.mode ?? 0o644) & 0o777,
      sha256: digest(file.contents),
    })),
  };
  options.mutateManifest?.(manifest);
  const descriptor = Buffer.from(JSON.stringify(manifest));
  if (options.descriptorSize !== undefined && options.descriptorSize < descriptor.length)
    throw new Error('Размер descriptor меньше сериализованного JSON.');
  const entries: ZipEntry[] = [
    ...files,
    {
      path: 'component.json',
      contents: options.descriptorSize
        ? Buffer.concat([descriptor, Buffer.alloc(options.descriptorSize - descriptor.length, ' ')])
        : descriptor,
      method: 8,
    },
    ...(options.extra ?? []),
  ];
  options.mutateEntries?.(entries);
  const bytes = zip(entries);
  options.mutateZip?.(bytes);
  return {
    bytes,
    wire: {
      packageSlug,
      kind: 'skill',
      name,
      version,
      metadata: {
        title: name,
        shortDescription: 'Test skill',
        longDescription: 'Test fixture',
        tags: [],
      },
      spec: {
        installName,
        archive: {
          path: `${installName}-${version}.zip`,
          size: bytes.length,
          sha256: digest(bytes),
        },
      },
      publishedAt: '2026-11-09T12:00:00Z',
      downloadCount: 0,
      installCount: 0,
    },
  };
}

export interface WireEvent {
  readonly event: 'download' | 'install';
  readonly eventId: string;
  readonly version: string;
  readonly components: readonly { readonly kind: 'skill'; readonly name: string }[];
}

/** Модель контракта core для подменяемого транспорта и HTTP e2e. Незнакомый маршрут даёт 501. */
export class TestRegistry {
  readonly releases = new Map<string, ReturnType<typeof registrySkill>[]>();
  readonly current = new Map<string, string>();
  readonly requests: string[] = [];
  readonly events: { slug: string; body: WireEvent }[] = [];
  readonly corrupt = new Set<string>();
  readonly failed = new Set<string>();
  readonly unexpected: string[] = [];
  eventStatus = 202;
  artifactOverride: Record<string, unknown> = {};

  constructor(readonly url = 'http://registry.test') {}

  release(slug: string, version: string, names: readonly string[]): void {
    this.releases.set(
      `${slug}@${version}`,
      names.map((name) => registrySkill(slug, name, version)),
    );
    this.current.set(slug, version);
  }

  http: HttpTransport = async (input, init) => {
    const url = new URL(String(input));
    this.requests.push(url.pathname + url.search);
    init?.signal?.throwIfAborted();
    if (url.pathname === '/api/v1/components' && url.searchParams.get('kind') === 'skill') {
      const q = url.searchParams.get('q')?.toLowerCase() ?? '';
      const items = [...this.current]
        .flatMap(([slug, version]) => this.releases.get(`${slug}@${version}`) ?? [])
        .map((item) => item.wire)
        .filter((item) => item.name.includes(q) || item.packageSlug.includes(q));
      if (url.searchParams.get('sort') !== 'popular') return new Response(null, { status: 400 });
      items.sort(
        (a, b) =>
          b.installCount - a.installCount ||
          a.name.localeCompare(b.name) ||
          a.packageSlug.localeCompare(b.packageSlug),
      );
      const limit = Number(url.searchParams.get('limit'));
      return Response.json({ items: items.slice(0, limit), total: items.length, offset: 0, limit });
    }
    const request =
      /^\/api\/v1\/packages\/([^/]+)(?:\/(events|components\/skill\/([^/]+)\/artifact))?$/.exec(
        url.pathname,
      );
    if (request) {
      const [, slug = '', endpoint, name] = request;
      const version = url.searchParams.get('version');
      if (this.failed.has(slug)) return new Response(null, { status: 503 });
      if (endpoint === 'events' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as WireEvent;
        const components = this.releases.get(`${slug}@${body.version}`) ?? [];
        if (
          !['install', 'download'].includes(body.event) ||
          !/^[a-f0-9-]{36}$/.test(body.eventId) ||
          !body.components.length ||
          body.components.some(
            (item) =>
              item.kind !== 'skill' || !components.some((entry) => entry.wire.name === item.name),
          ) ||
          Object.keys(body).sort().join() !== 'components,event,eventId,version'
        ) {
          this.unexpected.push('invalid package event');
          return new Response(null, { status: 400 });
        }
        this.events.push({ slug, body });
        return new Response(null, { status: this.eventStatus });
      }
      const selected = version ?? this.current.get(slug);
      const release = this.releases.get(`${slug}@${selected}`);
      if (!endpoint)
        return release
          ? Response.json({
              slug,
              version: selected,
              currentVersion: this.current.get(slug),
              metadata: { title: slug, shortDescription: slug, longDescription: slug, tags: [] },
              publishedAt: '2026-11-09T12:00:00Z',
              downloadCount: 0,
              installCount: 0,
              versions: [...this.releases.keys()]
                .filter((item) => item.startsWith(slug + '@'))
                .map((item) => item.split('@')[1]),
              components: release.map((item) => item.wire),
            })
          : new Response(null, { status: 404 });
      if (name && version) {
        const skill = release?.find((item) => item.wire.name === name);
        if (!skill) return new Response(null, { status: 404 });
        const { size, sha256 } = skill.wire.spec.archive;
        return Response.json({
          packageSlug: slug,
          kind: 'skill',
          name,
          version,
          size,
          sha256,
          url: `${this.url}/download/${slug}/${name}/${encodeURIComponent(version)}?signature=temporary`,
          expiresAt: '2099-01-01T00:00:00Z',
          ...this.artifactOverride,
        });
      }
    }
    const download = /^\/download\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (download && url.searchParams.get('signature') === 'temporary') {
      const [, slug, name, version] = download;
      const item = this.releases
        .get(`${slug}@${decodeURIComponent(version!)}`)
        ?.find((skill) => skill.wire.name === name);
      if (item)
        return new Response(
          Uint8Array.from(
            this.corrupt.has(`${slug}/${name}`)
              ? Buffer.from(item.bytes.map((byte, index) => (index === 0 ? byte ^ 1 : byte)))
              : item.bytes,
          ),
        );
    }
    this.unexpected.push(url.pathname + url.search);
    return new Response(null, { status: 501 });
  };
}
