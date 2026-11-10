import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { RegistryClient } from '@/registry/client';
import { prepareRegistrySource } from '@/sources/registry';
import { artifact, registryBytes } from '../helpers/registry.ts';
import { archiveBytes, skillText } from '../helpers/archive.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

const url = 'https://registry.test';
describe('registry source preparation', () => {
  it('uses the resolved artifact without resolving latest again and gives cleanup to its consumer', async () => {
    await withTestEnvironment(async (f) => {
      const http = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(registryBytes))),
        onDownload = vi.fn();
      const prepared = await prepareRegistrySource(
        { slug: 'demo' },
        new RegistryClient(url, http),
        { cwd: f.roots.cwd, temporaryDirectory: f.env.TMPDIR! },
        onDownload,
        artifact(`${url}/download`),
      );
      expect(prepared.identity).toEqual({ kind: 'registry', registryUrl: url, slug: 'demo' });
      expect(prepared.version).toBe('1.2.3');
      expect(onDownload).toHaveBeenCalledExactlyOnceWith(prepared.download);
      expect(http).toHaveBeenCalledTimes(1);
      expect(String(http.mock.calls[0]![0])).toBe(`${url}/download`);
      expect(JSON.stringify(prepared.download)).not.toContain('/download');
      await prepared.cleanup();
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
    });
  });
  it.each(['slug', 'version'] as const)(
    'rejects a resolved %s mismatch before downloading',
    async (field) => {
      await withTestEnvironment(async (f) => {
        const http = vi.fn<typeof fetch>();
        const selected = artifact(
          `${url}/download`,
          field === 'slug' ? { slug: 'other' } : { version: '2.0.0' },
        );
        await expect(
          prepareRegistrySource(
            { slug: 'demo', version: '1.2.3' },
            new RegistryClient(url, http),
            { cwd: f.roots.cwd, temporaryDirectory: f.env.TMPDIR! },
            undefined,
            selected,
          ),
        ).rejects.toMatchObject({ code: 'ARTIFACT_MISMATCH' });
        expect(http).not.toHaveBeenCalled();
        expect(await readdir(f.env.TMPDIR!)).toEqual([]);
      });
    },
  );
  it('cleans a verified archive whose SKILL.md name differs from its slug', async () => {
    await withTestEnvironment(async (f) => {
      const bytes = archiveBytes([
        { path: 'SKILL.md', contents: skillText.replace('name: demo', 'name: other') },
      ]);
      const selected = artifact(`${url}/download`, {
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }),
        onDownload = vi.fn();
      await expect(
        prepareRegistrySource(
          { slug: 'demo' },
          new RegistryClient(url, async () => new Response(new Uint8Array(bytes))),
          { cwd: f.roots.cwd, temporaryDirectory: f.env.TMPDIR! },
          onDownload,
          selected,
        ),
      ).rejects.toMatchObject({ code: 'ARTIFACT_MISMATCH' });
      expect(onDownload).toHaveBeenCalledTimes(1);
      expect(await readdir(f.env.TMPDIR!)).toEqual([]);
    });
  });
});
