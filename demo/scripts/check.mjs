import { readFile } from 'node:fs/promises';

const marker = await readFile(new URL('../references/marker.txt', import.meta.url), 'utf8');
if (marker.trim() !== 'DEMO_SKILL_OK') {
  throw new Error('Unexpected demo skill marker.');
}
console.log(marker.trim());
