import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Проверяет переданную через env стабильную версию и согласованность manifest/lock без изменения файлов.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
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
  lock.packages[''].version,
  manifest.version,
  'package-lock.json must match the release version',
);
