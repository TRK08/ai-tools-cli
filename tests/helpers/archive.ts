import { gzipSync } from 'node:zlib';
import { Header, type HeaderData } from 'tar';

export const skillText = '---\nname: demo\ndescription: Demo skill\n---\nInstructions\n';

export type TarFixtureEntry = HeaderData & { readonly contents?: Buffer | string };

/** Raw fixtures retain unsafe paths/types which a filesystem tar writer would sanitize. */
export function rawTar(entries: readonly TarFixtureEntry[], endBlocks = 2): Buffer {
  const chunks: Buffer[] = [];
  for (const { contents = '', ...data } of entries) {
    const body = Buffer.from(contents);
    const header = new Header({
      mode: 0o644,
      size: body.length,
      ...data,
      type: data.type === 'Unsupported' ? 'File' : (data.type ?? 'File'),
    });
    header.encode();
    if (data.type === 'Unsupported') {
      header.block![156] = 'Z'.charCodeAt(0);
      header.block!.fill(32, 148, 156);
      const checksum = header.block!.reduce((sum, byte) => sum + byte, 0);
      header.block!.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    }
    chunks.push(header.block!, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(endBlocks * 512));
  return Buffer.concat(chunks);
}

export function archiveBytes(entries: readonly TarFixtureEntry[]): Buffer {
  return gzipSync(rawTar(entries));
}
