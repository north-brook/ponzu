/**
 * A gzipped tar that depends only on its files: entries sorted by name, every one a plain file
 * owned by 0:0, mode 0644, with one fixed mtime, and a gzip header with no time and a fixed OS.
 * The same files make the same bytes, and so the same sha256, on any machine with the same zlib.
 */
import { gzipSync } from "node:zlib";

export interface TgzFile {
  name: string;
  bytes: Uint8Array;
}

/** 2026-01-01T00:00:00Z: a fixed time, so tar on extraction has nothing to warn of. */
export const TGZ_MTIME = 1_767_225_600;

const BLOCK = 512;

export function tgz(files: readonly TgzFile[]): Uint8Array {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const file of sorted) {
    if (seen.has(file.name)) throw new Error(`${file.name} is in the bundle twice.`);
    seen.add(file.name);
    parts.push(header(file.name, file.bytes.length));
    parts.push(file.bytes);
    const pad = (BLOCK - (file.bytes.length % BLOCK)) % BLOCK;
    if (pad) parts.push(new Uint8Array(pad));
  }
  // The end of the archive: two empty blocks.
  parts.push(new Uint8Array(BLOCK * 2));
  const tar = Buffer.concat(parts);
  const gz = gzipSync(tar, { level: 9 });
  // The gzip header's OS byte is zlib's build platform; say Unix wherever this runs. Its mtime
  // (bytes 4 to 7) is already zero.
  gz[9] = 3;
  return new Uint8Array(gz.buffer, gz.byteOffset, gz.byteLength);
}

function header(name: string, size: number): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const put = (offset: number, length: number, value: string) => {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length > length) throw new Error(`${name}: "${value}" does not fit the tar header.`);
    h.set(bytes, offset);
  };
  const octal = (value: number, length: number) =>
    `${value.toString(8).padStart(length - 1, "0")}\0`;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`${name} is not a plain file name.`);
  put(0, 100, name);
  put(100, 8, octal(0o644, 8));
  put(108, 8, octal(0, 8));
  put(116, 8, octal(0, 8));
  put(124, 12, octal(size, 12));
  put(136, 12, octal(TGZ_MTIME, 12));
  // The checksum is summed with its own field as spaces.
  put(148, 8, "        ");
  put(156, 1, "0");
  put(257, 6, "ustar\0");
  put(263, 2, "00");
  put(265, 32, "root");
  put(297, 32, "root");
  let sum = 0;
  for (const byte of h) sum += byte;
  put(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}
