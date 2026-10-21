import { describe, expect, it, vi } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'fast-string-width';
import { createFrame, createScreen } from '../../src/cli/terminal/screen.ts';
import { terminal } from '../helpers/terminal.ts';

describe('terminal frame ownership', () => {
  it('counts physical rows of the prior Unicode/ANSI frame after resize', () => {
    const t = terminal(true, true, 30),
      screen = createScreen(t.output);
    try {
      screen.write(['\u001b[1m界界界界界\u001b[0m', 'line']);
      t.output.columns = 5;
      const offset = t.rendered().length;
      screen.write(['next']);
      expect(t.rendered().slice(offset)).toBe('\u001b[3A\r\u001b[Jnext\n');
      t.output.columns = 30;
      screen.clear();
      expect(t.rendered().endsWith('\u001b[1A\r\u001b[J')).toBe(true);
      const cleared = t.rendered();
      screen.clear();
      expect(t.rendered()).toBe(cleared);
    } finally {
      screen.close();
      t.close();
    }
  });

  it('shows its cursor when clearing fails and closes idempotently', () => {
    const t = terminal(),
      screen = createScreen(t.output);
    screen.hideCursor();
    screen.write(['frame']);
    const failure = new Error('clear failure');
    vi.spyOn(t.output, 'write').mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => screen.close()).toThrow(failure);
    expect(t.rendered().endsWith('\u001b[?25h')).toBe(true);
    const stopped = t.rendered();
    screen.close();
    expect(t.rendered()).toBe(stopped);
    t.close();
  });

  it('keeps an inline indicator on its own line and restores the cursor without grabbing input', () => {
    const t = terminal(),
      screen = createScreen(t.output, true);
    try {
      screen.hideCursor();
      screen.write(['first']);
      screen.write(['second']);
      expect(stripVTControlCharacters(t.rendered())).not.toContain('\n');
      screen.close();
      expect(t.rendered().endsWith('\r\u001b[2K\u001b[?25h')).toBe(true);
      expect(t.input.isRaw).toBe(false);
      expect(t.input.readableFlowing).not.toBe(true);
    } finally {
      t.close();
    }
  });

  it('bounds plain and formatted lines by display width before adding ANSI', () => {
    const t = terminal(true, true, 12),
      frame = createFrame(t.output);
    frame.add('👩‍💻界界界界界', 'cyan');
    frame.section('Раздел');
    expect(frame.lines.every((line) => stringWidth(line) < 12)).toBe(true);
    expect(stripVTControlCharacters(frame.lines[0]!)).toContain('…');
    t.close();
  });
});
