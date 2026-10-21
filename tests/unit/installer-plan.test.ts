import { describe, expect, it } from 'vitest';
import {
  createInstallPlan,
  findReusableInstallation,
  localUpdateReason,
  registryUpdateReason,
  createUpdatePreview,
} from '../../src/installer/plan.ts';
import type { InstallationRecord } from '../../src/state/types.ts';
import type { RegistryArtifact } from '../../src/registry/client.ts';

const record: InstallationRecord = {
  name: 'demo',
  source: { kind: 'registry', registryUrl: 'https://registry.example', slug: 'demo' },
  version: '1.0.0',
  policy: 'latest',
  contentHash: 'a'.repeat(64),
  archiveHash: 'b'.repeat(64),
  agents: ['codex'],
  connections: [{ agent: 'codex', kind: 'direct' as const, path: '.agents/skills/demo' }],
};
const artifact: RegistryArtifact = {
  slug: 'demo',
  version: '1.0.0',
  sha256: 'b'.repeat(64),
  size: 123,
  url: 'https://registry.example/signed',
  expiresAt: '2099-01-01T00:00:00Z',
  format: 'tar.gz',
};
const content = {
  ownership: 'reuse' as const,
  name: 'demo',
  identity: record.source,
  description: null,
  directory: '/project/.agents/skills/demo',
  version: '1.0.0',
  contentHash: 'a'.repeat(64),
  archiveHash: 'b'.repeat(64),
};
const snapshot = {
  previous: record,
  contentHash: 'a'.repeat(64),
  copies: [{ path: content.directory, owned: true, exists: true, contentHash: record.contentHash }],
  destinations: record.connections.map((connection) => ({ connection, exists: true })),
  candidates: record.connections,
  errors: [],
  connectionsNeedRepair: false,
};

describe('pure installation decisions', () => {
  it('reuses only the same version, archive and intact installed content', () => {
    expect(findReusableInstallation(record, artifact, 'a'.repeat(64))).toBe(record);
    expect(
      findReusableInstallation(record, { ...artifact, version: '2.0.0' }, 'a'.repeat(64)),
    ).toBeNull();
    expect(
      findReusableInstallation(record, { ...artifact, sha256: 'c'.repeat(64) }, 'a'.repeat(64)),
    ).toBeNull();
    expect(findReusableInstallation(record, artifact, null)).toBeNull();
    expect(findReusableInstallation(undefined, artifact, 'a'.repeat(64))).toBeNull();
  });

  it('distinguishes an intact repeat from policy-only metadata without mutating inputs', () => {
    const previous = Object.freeze({ ...record, policy: 'exact' as const });
    const before = Object.freeze({ ...snapshot, previous });
    expect(createInstallPlan(content, before, record.source, 'exact', false).kind).toBe(
      'unchanged',
    );
    expect(createInstallPlan(content, before, record.source, 'latest', false).kind).toBe(
      'metadata-only',
    );
    expect(previous.policy).toBe('exact');
  });

  it('requires application for a new connection even when shared content is intact', () => {
    const next = {
      ...snapshot,
      candidates: [
        ...snapshot.candidates,
        { agent: 'pi' as const, kind: 'direct' as const, path: '.agents/skills/demo' },
      ],
    };
    const plan = createInstallPlan(content, next, record.source, 'latest', false);
    expect(plan.kind).toBe('apply');
    expect(plan.content.ownership).toBe('reuse');
  });

  it('requires application for missing connections and preserves preflight errors', () => {
    expect(
      createInstallPlan(
        content,
        { ...snapshot, connectionsNeedRepair: true },
        record.source,
        'latest',
        false,
      ).kind,
    ).toBe('apply');
    const rejected = createInstallPlan(
      content,
      { ...snapshot, candidates: [], errors: ['pi: чужой объект'] },
      record.source,
      'latest',
      false,
    );
    expect(rejected.kind).toBe('apply');
    expect(rejected.snapshot.errors).toEqual(['pi: чужой объект']);
  });

  it('keeps the selected artifact version when planning a replacement', () => {
    const next = {
      ...content,
      ownership: 'prepared' as const,
      version: '2.0.0',
      contentHash: 'c'.repeat(64),
    };
    const plan = createInstallPlan(next, snapshot, record.source, 'latest', true);
    expect(plan.kind).toBe('apply');
    expect(plan.content.version).toBe('2.0.0');
    expect(plan.force).toBe(true);
  });

  it('classifies changed archive metadata separately from unchanged unpacked contents', () => {
    const next = { ...content, ownership: 'prepared' as const, archiveHash: 'c'.repeat(64) };
    expect(createInstallPlan(next, snapshot, record.source, 'latest', false).kind).toBe(
      'metadata-only',
    );
  });

  it('prioritizes registry version, archive, copy and connections in update previews', () => {
    expect(
      registryUpdateReason(
        record,
        { ...artifact, version: '2.0.0', sha256: 'c'.repeat(64) },
        null,
        true,
      ),
    ).toBe('version');
    expect(registryUpdateReason(record, { ...artifact, sha256: 'c'.repeat(64) }, null, true)).toBe(
      'artifact',
    );
    expect(registryUpdateReason(record, artifact, null, true)).toBe('copy');
    expect(registryUpdateReason(record, artifact, record.contentHash, true)).toBe('connections');
    expect(registryUpdateReason(record, artifact, record.contentHash, false)).toBeNull();
  });

  it('prioritizes local copy protection over source, archive and connection differences', () => {
    expect(
      localUpdateReason(
        record,
        { ...content, contentHash: 'c'.repeat(64) },
        { ...snapshot, contentHash: null, copies: [{ ...snapshot.copies[0]!, contentHash: null }] },
      ),
    ).toBe('copy');
    expect(localUpdateReason(record, { ...content, contentHash: 'c'.repeat(64) }, snapshot)).toBe(
      'source',
    );
    expect(localUpdateReason(record, { ...content, archiveHash: 'c'.repeat(64) }, snapshot)).toBe(
      'artifact',
    );
    expect(localUpdateReason(record, content, { ...snapshot, connectionsNeedRepair: true })).toBe(
      'connections',
    );
    expect(localUpdateReason(record, content, snapshot)).toBeNull();
  });

  it('reports pinned and unchanged updates without pretending a latest version is known', () => {
    expect(createUpdatePreview(record, 'global', null, 'pinned')).toMatchObject({
      status: 'pinned',
      latestVersion: null,
      agents: ['codex'],
    });
    expect(createUpdatePreview(record, 'project', '1.0.0', null)).toMatchObject({
      status: 'unchanged',
      reason: null,
    });
  });
});
