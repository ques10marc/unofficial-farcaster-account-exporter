// Export directory writer. Each run writes a new directory (mode 0700, files 0600). Every file is
// written exactly once ('wx'), so a finished export is never modified. SHA256SUMS covers every file
// except OS metadata that Finder or Explorer may add later.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { utcStamp } from './util.ts';

const OS_METADATA = [/^\.DS_Store$/, /^\._/, /^\.Spotlight-V100$/, /^\.Trashes$/, /^\.fseventsd$/, /^Thumbs\.db$/i, /^desktop\.ini$/i, /^Icon\r$/];
export const isOsMetadata = (name: string): boolean => OS_METADATA.some((r) => r.test(name));

export const SUMS_FILE = 'SHA256SUMS';

// Lists regular files under root (relative, sorted, '/' separators), skipping OS metadata. Symlinks and
// other non-regular entries are reported separately so verify can flag them.
export function listExportFiles(root: string): { files: string[]; irregular: string[] } {
  const files: string[] = [];
  const irregular: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (isOsMetadata(e.name)) continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(rel);
      else irregular.push(rel);
    }
  };
  walk(root);
  files.sort();
  irregular.sort();
  return { files, irregular };
}

export const sha256File = (p: string): string => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// Length-delimited protobuf stream: varint(length) + bytes, repeated. The standard framing for
// multiple protobuf messages in one file (writeDelimitedTo / parseDelimitedFrom).
export function encodeDelimited(items: Uint8Array[]): Buffer {
  const parts: Buffer[] = [];
  for (const b of items) {
    let n = b.length;
    const v: number[] = [];
    while (n > 0x7f) {
      v.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    v.push(n);
    parts.push(Buffer.from(v), Buffer.from(b));
  }
  return Buffer.concat(parts);
}

export function decodeDelimited(buf: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < buf.length) {
    let len = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated varint in delimited stream');
      const b = buf[i++];
      len += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) break;
      shift += 7;
    }
    if (i + len > buf.length) throw new Error('truncated message in delimited stream');
    out.push(buf.subarray(i, i + len));
    i += len;
  }
  return out;
}

export class ExportWriter {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  // Creates <outParent>/fc-export-<fid>-<UTC>. Fails if it already exists. protect runs while the folder
  // is still empty (owner-only permissions are in place before any file is written); if it throws, the
  // empty folder is removed (non-recursive rmdir can remove nothing else) and the error passes on.
  static create(outParent: string, fid: number, now = new Date(), protect?: (root: string) => void): ExportWriter {
    fs.mkdirSync(outParent, { recursive: true, mode: 0o700 });
    const root = path.join(path.resolve(outParent), `fc-export-${fid}-${utcStamp(now)}`);
    fs.mkdirSync(root, { mode: 0o700 });
    fs.chmodSync(root, 0o700);
    try {
      protect?.(root);
    } catch (e) {
      fs.rmdirSync(root);
      throw e;
    }
    return new ExportWriter(root);
  }

  private prepare(rel: string): string {
    if (path.isAbsolute(rel) || rel.split('/').includes('..')) throw new Error(`unsafe export path: ${rel}`);
    const p = path.join(this.root, rel);
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // mkdir's mode is masked by umask; set every new level explicitly.
      for (let d = dir; d.startsWith(this.root) && d !== this.root; d = path.dirname(d)) fs.chmodSync(d, 0o700);
    }
    return p;
  }

  exists(rel: string): boolean {
    return fs.existsSync(path.join(this.root, rel));
  }

  write(rel: string, data: string | Uint8Array): void {
    const p = this.prepare(rel);
    fs.writeFileSync(p, data, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(p, 0o600);
  }

  writeJson(rel: string, value: unknown): void {
    this.write(rel, JSON.stringify(value, null, 2) + '\n');
  }

  writeJsonl(rel: string, rows: unknown[]): void {
    this.write(rel, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  }

  writeDelimited(rel: string, items: Uint8Array[]): void {
    this.write(rel, encodeDelimited(items));
  }

  // Last step of an export: checksums for every file written so far.
  sealChecksums(): number {
    const { files } = listExportFiles(this.root);
    const lines = files.filter((f) => f !== SUMS_FILE).map((f) => `${sha256File(path.join(this.root, f))}  ${f}`);
    this.write(SUMS_FILE, lines.join('\n') + '\n');
    return lines.length;
  }
}
