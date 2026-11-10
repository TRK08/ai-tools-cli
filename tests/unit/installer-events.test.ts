import { describe, expect, it, vi } from 'vitest';
import { InstallationEvents } from '@/installer/events';
import { AddSkipped, UpdateSkipped } from '@/installer/control';
import type { InstallationChange, SourceSelection } from '@/installer/types';
import { RegistryClient } from '@/registry/client';
import type { Telemetry } from '@/telemetry/client';

const source: SourceSelection = {
  input: 'demo',
  identity: { kind: 'registry', registryUrl: 'https://registry.test', slug: 'demo' },
  policy: 'latest',
  artifact: null,
  registry: {
    reference: { slug: 'demo' },
    client: new RegistryClient('https://registry.test', async () => {
      throw new Error('Unexpected HTTP');
    }),
  },
};
const download = {
  registryUrl: 'https://registry.test',
  slug: 'demo',
  version: '1.0.0',
  archiveHash: 'a'.repeat(64),
  size: 10,
};

function fixture() {
  const emit = vi.fn<Telemetry['emit']>(),
    onDownload = vi.fn();
  const events = new InstallationEvents(
    { telemetry: { emit } as unknown as Telemetry, onDownload },
    'update',
    'global',
    ['codex'],
  );
  return { events, emit, onDownload };
}

describe('registry operation events', () => {
  it('emits a verified download and one installation for all affected agents', () => {
    const { events, emit, onDownload } = fixture();
    events.select(source);
    events.includeAgents(['codex', 'pi']);
    events.resolve('1.0.0');
    events.download(download);
    events.complete({
      name: 'demo',
      status: 'success',
      changes: { content: true, connections: true, metadata: true },
    });
    expect(emit.mock.calls.map((call) => call[0])).toEqual(['download', 'install']);
    expect(emit.mock.calls[1]).toEqual([
      'install',
      {
        registryUrl: 'https://registry.test',
        slug: 'demo',
        version: '1.0.0',
        operation: 'update',
        scope: 'global',
        agents: ['codex', 'pi'],
      },
      'success',
    ]);
    expect(onDownload).toHaveBeenCalledExactlyOnceWith(download);
  });
  it.each([
    { status: 'unchanged' },
    { status: 'success', changes: { content: false, connections: false, metadata: true } },
    { status: 'success', changes: { content: false, connections: true, metadata: false } },
    { status: 'partial', errors: ['connection'] },
    { status: 'failed', errors: ['failure'] },
  ])('counts only real changes or failures: %j', (result) => {
    const { events, emit } = fixture();
    events.select(source);
    events.complete({ name: 'demo', ...result } as InstallationChange);
    if (
      result.status === 'unchanged' ||
      (result.status === 'success' && !result.changes?.connections)
    )
      expect(emit).not.toHaveBeenCalled();
    else
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        'install',
        expect.objectContaining({ slug: 'demo' }),
        result.status === 'success' ? 'success' : result.status,
      );
  });
  it.each(['error', 'decline', 'cancel'] as const)(
    'records failure except user decision: %s',
    (kind) => {
      const { events, emit } = fixture();
      events.select(source);
      events.fail(
        kind === 'error'
          ? new Error('operation')
          : kind === 'decline'
            ? new AddSkipped({ name: 'demo', status: 'skipped', reason: 'declined' })
            : new UpdateSkipped({ name: 'demo', status: 'skipped', reason: 'cancelled' }),
      );
      expect(emit).toHaveBeenCalledTimes(kind === 'error' ? 1 : 0);
    },
  );
  it('does not emit registry events for a local source', () => {
    const { events, emit } = fixture();
    events.select({
      ...source,
      registry: null,
      identity: { kind: 'directory', path: '/source' },
      policy: 'local',
    });
    events.includeAgents(['pi']);
    events.resolve('1.0.0');
    events.download(download);
    events.complete({ name: 'demo', status: 'partial', errors: ['failure'] });
    events.fail(new Error('failure'));
    expect(emit).not.toHaveBeenCalled();
  });
});
