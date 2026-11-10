import { expect, it, vi } from 'vitest';
import { Telemetry } from '@/telemetry';
import { withTestEnvironment } from '../helpers/test-environment.ts';
import { TestRegistry } from '../helpers/registry.ts';

const input = {
  registryUrl: 'http://registry.test',
  slug: 'docs',
  version: '1.0.0',
  components: ['check', 'check'],
};

it('posts deduplicated components on the exact package release and suppresses empty events', async () => {
  const registry = new TestRegistry();
  registry.release('docs', '1.0.0', ['check', 'compare']);
  await withTestEnvironment(async (context) => {
    const telemetry = new Telemetry({ ...context, env: {}, http: registry.http });
    telemetry.emit('download', input);
    telemetry.emit('install', { ...input, components: [] });
    await telemetry.flush();
    expect(registry.events).toEqual([
      {
        slug: 'docs',
        body: {
          event: 'download',
          eventId: expect.stringMatching(/^[a-f0-9-]{36}$/),
          version: '1.0.0',
          components: [{ kind: 'skill', name: 'check' }],
        },
      },
    ]);
  });
});

it.each(['DISABLE_TELEMETRY', 'DO_NOT_TRACK', 'option'])('respects %s', async (key) => {
  await withTestEnvironment(async (context) => {
    const http = vi.fn<typeof fetch>();
    const telemetry = new Telemetry(
      { ...context, env: { [key]: '1' }, http },
      { disabled: key === 'option' },
    );
    telemetry.emit('install', input);
    await telemetry.flush();
    expect(http).not.toHaveBeenCalled();
  });
});

it('flush times out and aborts a transport that never settles', async () => {
  await withTestEnvironment(async (context) => {
    const http = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const telemetry = new Telemetry({ ...context, env: {}, http }, { timeoutMs: 5 });
    telemetry.emit('install', input);
    await telemetry.flush();
    expect(http.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
