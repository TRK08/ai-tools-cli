import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { packageRunner, quoteCmdArgument } from '../scripts/package-runner.ts';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => 'output') }));

describe('npm and installed-bin runner', () => {
  it('uses npm_execpath and the current Node without shell lookup', () => {
    const env = { HOME: '/fixture/home' };
    expect(packageRunner(env, '/npm/npm-cli.js').npm(['pack', 'source & name'], '/fixture')).toBe(
      'output',
    );
    expect(execFileSync).toHaveBeenLastCalledWith(
      process.execPath,
      ['/npm/npm-cli.js', 'pack', 'source & name'],
      expect.objectContaining({ env, cwd: '/fixture' }),
    );
    expect(() => packageRunner(env)).toThrow('npm run package:smoke');
  });

  it('runs a POSIX executable directly with an argument array', () => {
    packageRunner({}, '/npm/cli', 'linux').bin(
      '/fixture/bin',
      ['a & b', '%PATH%', 'кириллица'],
      '/fixture',
    );
    expect(execFileSync).toHaveBeenLastCalledWith(
      '/fixture/bin',
      ['a & b', '%PATH%', 'кириллица'],
      expect.any(Object),
    );
  });

  it('uses cmd with AutoRun and delayed expansion disabled for the real Windows shim', () => {
    packageRunner(
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: 'system' },
      'C:\\npm\\npm-cli.js',
      'win32',
    ).bin(
      'C:\\Проект с пробелами\\skills-installer.cmd',
      ['add', 'C:\\скилл & %PATH% ! ^ (x)'],
      'C:\\fixture',
    );
    const call = vi.mocked(execFileSync).mock.calls.at(-1)!;
    expect(call[0]).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(call[1]?.slice(0, 4)).toEqual(['/d', '/s', '/v:off', '/c']);
    expect(call[2]).toMatchObject({ windowsVerbatimArguments: true, cwd: 'C:\\fixture' });
    const command = String(call[1]?.[4]);
    expect(command).toContain('skills-installer.cmd');
    expect(command).toContain('^^^&');
    expect(command).toContain('^^^%PATH^^^%');
    expect(command).toContain('^^^!');
  });

  it.each(['line\nfeed', 'return\r', 'nul\0'])('rejects control character argument %j', (arg) => {
    expect(() => quoteCmdArgument(arg)).toThrow('cmd');
  });

  it('quotes embedded quotes and trailing backslashes before escaping both cmd passes', () => {
    expect(quoteCmdArgument('')).toBe('""');
    const slash = String.fromCharCode(92);
    expect(quoteCmdArgument('a"b', false)).toBe('^"a' + slash + '^"b^"');
    expect(quoteCmdArgument('a b' + slash, false)).toBe('^"a^ b' + slash + slash + '^"');
  });
});
