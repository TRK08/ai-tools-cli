import { describe, expect, it } from 'vitest';
import { readSkillMetadata } from '../src/sources/frontmatter.ts';

describe('skill frontmatter', () => {
  it('reads quoted strings and a multiline description without returning a rewritten document', () => {
    expect(
      readSkillMetadata(
        '---\nname: "Demo skill"\ndescription: |\n  First line\n  Second line\nmetadata: {version: 2}\n---\n# Instructions\n',
      ),
    ).toEqual({
      name: 'Demo skill',
      description: 'First line\nSecond line\n',
    });
  });

  it('accepts BOM, CRLF and a closing delimiter at EOF', () => {
    expect(readSkillMetadata('\uFEFF---\r\nname: demo\r\ndescription: Demo\r\n---')).toEqual({
      name: 'demo',
      description: 'Demo',
    });
  });

  it('allows ordinary YAML aliases', () => {
    expect(readSkillMetadata('---\nname: &skill demo\ndescription: *skill\n---\n')).toEqual({
      name: 'demo',
      description: 'demo',
    });
  });

  it.each([
    ['missing frontmatter', '# Demo'],
    ['frontmatter later in body', '# Demo\n---\nname: demo\ndescription: Demo\n---\n'],
    ['missing closing delimiter', '---\nname: demo\ndescription: Demo\n'],
    ['JavaScript format', '---javascript\n({ name: "demo", description: "Demo" })\n---\n'],
    ['malformed YAML', '---\nname: [broken\ndescription: Demo\n---\n'],
    ['empty YAML', '---\n\n---\n'],
    ['sequence', '---\n- demo\n- description\n---\n'],
    ['scalar', '---\ndemo\n---\n'],
    ['missing name', '---\ndescription: Demo\n---\n'],
    ['missing description', '---\nname: demo\n---\n'],
    ['number name', '---\nname: 123\ndescription: Demo\n---\n'],
    ['object description', '---\nname: demo\ndescription: {text: Demo}\n---\n'],
    ['blank description', '---\nname: demo\ndescription: "  "\n---\n'],
    ['duplicate key', '---\nname: demo\nname: other\ndescription: Demo\n---\n'],
    ['unresolved alias', '---\nname: demo\ndescription: *missing\n---\n'],
    ['JavaScript tag', '---\nname: demo\ndescription: !!js/function "() => 1"\n---\n'],
    ['unknown tag', '---\nname: !custom demo\ndescription: Demo\n---\n'],
  ])('rejects %s', (_label, text) => {
    expect(() => readSkillMetadata(text)).toThrowError(
      expect.objectContaining({ code: 'INVALID_METADATA' }),
    );
  });

  it.each([
    '',
    ' ',
    '.',
    '..',
    '../escape',
    '/absolute',
    'a/b',
    'a\\b',
    'a\nb',
    'a\0b',
    'ä'.repeat(128),
    'CON',
    'nul.txt',
    'COM1',
    'LPT²',
    'a:b',
    'demo.',
    'demo ',
    '\ud800',
  ])('rejects unsafe skill name %j', (name) => {
    expect(() =>
      readSkillMetadata(`---\nname: ${JSON.stringify(name)}\ndescription: Demo\n---\n`),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_METADATA' }));
  });

  it('bounds YAML alias expansion', () => {
    const aliases = Array.from({ length: 120 }, () => '*base').join(', ');
    expect(() =>
      readSkillMetadata(
        `---\nname: demo\ndescription: Demo\nbase: &base [one, two]\nexpanded: [${aliases}]\n---\n`,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_METADATA' }));
  });
});
