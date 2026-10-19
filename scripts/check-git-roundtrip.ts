import { resolve } from 'node:path';
import { consumeGitBundles, localGitRoundtrip, produceGitBundles } from './git-roundtrip.ts';

const [mode = 'local', directory, ...extra] = process.argv.slice(2);
if (extra.length || (mode !== 'local' && !directory) || (mode === 'local' && directory))
  throw new Error('npm run test:git -- local | produce <directory> | consume <directory>');
switch (mode) {
  case 'local':
    await localGitRoundtrip();
    break;
  case 'produce':
    await produceGitBundles(resolve(directory!));
    break;
  case 'consume':
    await consumeGitBundles(resolve(directory!));
    break;
  default:
    throw new Error(`Неизвестный режим Git-проверки: ${mode}`);
}
