import { expect, it } from 'vitest';
import { executeCli } from '../../src/cli/run.ts';
import { createProgram } from '../../src/cli/program.ts';
import { terminal } from '../helpers/terminal.ts';
import { withTestEnvironment } from '../helpers/test-environment.ts';

it.each([
  { args: ['--help'], stdout: 'Использование:', stderr: '', code: 'commander.helpDisplayed' },
  { args: ['--version'], stdout: 'context-version', stderr: '', code: 'commander.version' },
  {
    args: ['add', '--unknown'],
    stdout: '',
    stderr: 'неизвестный параметр',
    code: 'commander.unknownOption',
  },
])('routes $args to independently supplied streams', async ({ args, stdout, stderr, code }) => {
  await withTestEnvironment(async (runtime) => {
    const out = terminal(false, false),
      err = terminal(false, false);
    try {
      const program = createProgram({
        runtime,
        version: 'context-version',
        stdin: out.input,
        stdout: out.output,
        stderr: err.output,
      });
      for (const command of [program, ...program.commands]) command.exitOverride();
      await expect(program.parseAsync(args, { from: 'user' })).rejects.toMatchObject({ code });
      if (stdout) expect(out.rendered()).toContain(stdout);
      else expect(out.rendered()).toBe('');
      if (stderr) expect(err.rendered()).toContain(stderr);
      else expect(err.rendered()).toBe('');
    } finally {
      out.close();
      err.close();
    }
  });
});

it('uses the supplied stderr for the final command error', async () => {
  await withTestEnvironment(async (runtime) => {
    const out = terminal(false, false),
      err = terminal(false, false);
    try {
      expect(
        await executeCli(
          { runtime, version: 'test', stdin: out.input, stdout: out.output, stderr: err.output },
          ['add', 'demo'],
        ),
      ).toBe(1);
      expect(err.rendered()).toContain('Ошибка: Для выбора агентов');
      expect(out.rendered()).toBe('');
    } finally {
      out.close();
      err.close();
    }
  });
});

it.each([
  { args: ['help', 'add'], code: 0, output: 'Использование: skills-installer add', error: '' },
  { args: ['--version'], code: 0, output: 'context-version', error: '' },
  { args: ['add', '--unknown'], code: 1, output: '', error: 'Ошибка: неизвестный параметр' },
])(
  'returns $code for $args without duplicating Commander diagnostics',
  async ({ args, code, output, error }) => {
    await withTestEnvironment(async (runtime) => {
      const out = terminal(false, false),
        err = terminal(false, false);
      try {
        expect(
          await executeCli(
            {
              runtime,
              version: 'context-version',
              stdin: out.input,
              stdout: out.output,
              stderr: err.output,
            },
            args,
          ),
        ).toBe(code);
        if (output) expect(out.rendered()).toContain(output);
        else expect(out.rendered()).toBe('');
        if (error) {
          expect(err.rendered()).toContain(error);
          expect(err.rendered().match(/Ошибка:/g)).toHaveLength(1);
        } else expect(err.rendered()).toBe('');
      } finally {
        out.close();
        err.close();
      }
    });
  },
);
