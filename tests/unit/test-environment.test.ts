import { execFileSync } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { isolatedEnvironment } from '../../scripts/isolated-runtime.ts';
import type { HttpTransport } from '@/runtime';
import { withTestEnvironment } from '../helpers/test-environment.js';

describe('isolated test environment', () => {
  it('returns the callback result and removes all temporary files after success', async () => {
    const result = await withTestEnvironment(async (fixture) => {
      await writeFile(join(fixture.roots.cwd, 'project-file'), 'project');
      await writeFile(join(fixture.roots.home, 'home-file'), 'home');
      return { temporaryRoot: fixture.temporaryRoot, value: 'callback result' };
    });

    expect(result.value).toBe('callback result');
    await expect(access(result.temporaryRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes temporary files and preserves the callback error after failure', async () => {
    const failure = new Error('fixture failure');
    let temporaryRoot = '';

    await expect(
      withTestEnvironment(async (fixture) => {
        temporaryRoot = fixture.temporaryRoot;
        await writeFile(join(fixture.roots.home, 'partial-file'), 'partial');
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(temporaryRoot).not.toBe('');
    await expect(access(temporaryRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not change the process environment or working directory', async () => {
    const originalEnvironment = { ...process.env };
    const originalCwd = process.cwd();

    await withTestEnvironment(async (fixture) => {
      expect(fixture.roots.cwd).not.toBe(originalCwd);
      expect(fixture.roots.home).not.toBe(process.env.HOME);
      expect(process.env).toEqual(originalEnvironment);
      expect(process.cwd()).toBe(originalCwd);
    });

    expect(process.env).toEqual(originalEnvironment);
    expect(process.cwd()).toBe(originalCwd);
  });

  it('inherits only the case-insensitive system allowlist', async () => {
    const env = isolatedEnvironment(
      '/fixture',
      {},
      {
        Path: 'first',
        PATH: 'second',
        SystemRoot: 'C:\\Windows',
        windir: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        PATHEXT: '.COM;.EXE;.CMD',
        NODE_OPTIONS: '--inspect',
        SKILLS_API_TOKEN: 'secret',
        npm_config_registry: 'private',
      },
    );
    expect(env.PATH).toBe('second');
    expect(env.Path).toBeUndefined();
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.ComSpec).toContain('cmd.exe');
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.SKILLS_API_TOKEN).toBeUndefined();
    expect(env.npm_config_registry).toBeUndefined();
    expect(new Set(Object.keys(env).map((key) => key.toUpperCase())).size).toBe(
      Object.keys(env).length,
    );
  });

  it('protects case variants and removes dangerous explicit runtime overrides', async () => {
    await withTestEnvironment(
      async (f) => {
        expect(f.env.HOME).toBe(f.roots.home);
        expect(f.env.USERPROFILE).toBe(f.roots.home);
        expect(f.env.npm_config_prefix).toBe(join(f.temporaryRoot, 'npm-prefix'));
        expect(f.env.npm_config_userconfig).toBe(join(f.temporaryRoot, 'user.npmrc'));
        expect(f.env.NODE_OPTIONS).toBeUndefined();
        expect(f.env.NODE_PATH).toBeUndefined();
        expect(f.env.DO_NOT_TRACK).toBe('1');
        expect(new Set(Object.keys(f.env).map((key) => key.toUpperCase())).size).toBe(
          Object.keys(f.env).length,
        );
      },
      {
        env: {
          home: '/outside',
          userprofile: '/outside',
          NPM_CONFIG_PREFIX: '/outside',
          npm_config_userconfig: '/outside',
          Node_Options: '--require=/outside',
          NODE_PATH: '/outside',
          do_not_track: '0',
        },
      },
    );
  });

  it('keeps protected paths and telemetry isolated despite environment overrides', async () => {
    const protectedPaths = [
      'HOME',
      'USERPROFILE',
      'CLAUDE_CONFIG_DIR',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'XDG_CACHE_HOME',
      'CODEX_HOME',
      'TMPDIR',
      'TMP',
      'TEMP',
      'APPDATA',
      'LOCALAPPDATA',
      'npm_config_cache',
      'npm_config_prefix',
    ];

    await withTestEnvironment(
      async (fixture) => {
        for (const name of protectedPaths) {
          const value = fixture.env[name];
          expect(value).toBeDefined();
          if (value === undefined) throw new Error(`Missing isolated path: ${name}`);
          const pathFromRoot = relative(fixture.temporaryRoot, value);
          expect(isAbsolute(pathFromRoot)).toBe(false);
          expect(pathFromRoot.split(/[\\/]/)).not.toContain('..');
          await expect(access(value)).resolves.toBeUndefined();
        }

        expect(fixture.env.HOME).toBe(fixture.roots.home);
        expect(fixture.env.USERPROFILE).toBe(fixture.roots.home);
        expect(fixture.env.DISABLE_TELEMETRY).toBe('1');
        expect(fixture.env.DO_NOT_TRACK).toBe('1');
        expect(fixture.env.TEST_SCENARIO).toBe('custom');
      },
      {
        env: {
          ...Object.fromEntries(protectedPaths.map((name) => [name, '/outside-the-fixture'])),
          DISABLE_TELEMETRY: '0',
          DO_NOT_TRACK: '0',
          TEST_SCENARIO: 'custom',
        },
      },
    );
  });

  it('blocks HTTP unless a transport is explicitly supplied', async () => {
    await withTestEnvironment(async (fixture) => {
      await expect(fixture.http('https://example.invalid/')).rejects.toThrow(
        'HTTP requests are disabled in tests',
      );
    });
  });

  it('accepts an injected HTTP transport without making a real request', async () => {
    const http: HttpTransport = vi.fn(async () => new Response('stubbed response'));

    await withTestEnvironment(
      async (fixture) => {
        const response = await fixture.http('https://example.invalid/', { method: 'GET' });
        expect(await response.text()).toBe('stubbed response');
        expect(http).toHaveBeenCalledExactlyOnceWith('https://example.invalid/', { method: 'GET' });
      },
      { http },
    );
  });

  it('passes the isolated environment and working directory to a subprocess', async () => {
    await withTestEnvironment(async (fixture) => {
      const stdout = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          'import {homedir,tmpdir} from "node:os";console.log(JSON.stringify({ cwd: process.cwd(), env: process.env, home: homedir(), tmp: tmpdir() }))',
        ],
        {
          cwd: fixture.roots.cwd,
          env: fixture.env,
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      const child = JSON.parse(stdout) as {
        cwd: string;
        env: Record<string, string>;
        home: string;
        tmp: string;
      };

      expect(child.cwd).toBe(fixture.roots.cwd);
      expect(child.home).toBe(fixture.roots.home);
      expect(child.tmp).toBe(fixture.env.TMPDIR);
      expect(fixture.env.HOMEDRIVE! + fixture.env.HOMEPATH!).toBe(fixture.roots.home);
      expect(child.env).toMatchObject(fixture.env);
      expect(child.env.SKILLS_API_TOKEN).toBeUndefined();
      expect(child.env.NODE_OPTIONS).toBeUndefined();
    });
  });
});
