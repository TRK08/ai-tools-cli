import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Проверяет стабильную версию из env и согласованность manifest/lock; при расхождении завершает процесс ошибкой без записи файлов. */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as {
  packages: Record<string, { version: string }>;
};
assert.match(
  process.env.RELEASE_VERSION ?? '',
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  'Only stable SemVer releases are supported',
);
assert.equal(
  manifest.version,
  process.env.RELEASE_VERSION,
  'Release version must match package.json',
);
assert.equal(
  lock.packages['']!.version,
  manifest.version,
  'package-lock.json must match the release version',
);
