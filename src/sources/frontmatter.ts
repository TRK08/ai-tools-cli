import { isMap, parseDocument } from 'yaml';
import { assertSkillName } from '../state/paths.ts';
import { SourceError } from './errors.ts';

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
}

/** Read YAML data only; the caller keeps the original SKILL.md bytes. */
export function readSkillMetadata(raw: string): SkillMetadata {
  const match = raw.match(/^\uFEFF?---[\t ]*\r?\n([\s\S]*?)^---[\t ]*(?:\r?\n|$)/m);
  // The multiline closing delimiter must not allow frontmatter later in the body.
  if (!match || match.index !== 0) {
    throw new SourceError(
      'INVALID_METADATA',
      'SKILL.md должен начинаться с метаданных в формате YAML.',
    );
  }

  try {
    const document = parseDocument(match[1]!, {
      schema: 'core',
      customTags: [],
      resolveKnownTags: false,
      merge: false,
      uniqueKeys: true,
    });
    const issue = document.errors[0] ?? document.warnings[0];
    if (issue) throw issue;
    if (!isMap(document.contents)) throw new Error('Метаданные должны быть словарём YAML.');
    const data: unknown = document.toJS({ mapAsMap: true, maxAliasCount: 100 });
    if (!(data instanceof Map)) throw new Error('Метаданные должны быть словарём YAML.');
    const name: unknown = data.get('name');
    const description: unknown = data.get('description');
    if (typeof name !== 'string' || typeof description !== 'string' || !description.trim()) {
      throw new Error('Метаданные должны содержать непустые строки name и description.');
    }
    assertSkillName(name);
    return { name, description };
  } catch (cause) {
    throw new SourceError(
      'INVALID_METADATA',
      'Некорректный YAML или обязательные метаданные в SKILL.md.',
      {
        cause,
      },
    );
  }
}
