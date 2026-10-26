// Media for the user's own casts and bookmarked casts (D14): content-addressed bytes under media/sha256/
// plus media/index.jsonl with a final status for every embed URL (AC-19). Media requests never carry the
// session token or any other credential.
//
// Embed URLs are untrusted input, so: http(s) only, redirects followed manually (max 5) with every hop
// checked, and hosts that are or resolve to loopback/private/link-local addresses are refused, IPv4
// addresses written as IPv6 included. Only image/video/audio/pdf/playlist bodies are stored; other
// responses (web pages) get a status only. Each body is capped at MAX_BYTES, and once the stored media
// reach MAX_TOTAL_BYTES the remaining URLs are skipped without a request. Requests connect only to an
// address that passed the check, so a host can't pass with one DNS answer and then be reached at another
// (DNS rebinding).

import { createHash } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import type { ExportWriter } from './writer.ts';
import { errMessage, interrupt, sleep } from './util.ts';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const PER_HOST_GAP_MS = 250;
const MAX_REDIRECTS = 5;

export type MediaOrigin = 'own' | 'bookmark';

export interface MediaRef {
  url: string;
  castHash: string;
  origin?: MediaOrigin; // default 'own'
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'other';

export interface MediaIndexRow {
  url: string;
  castHashes: string[];
  origins: MediaOrigin[];
  status: number | null; // final HTTP status; null when no response (error says why)
  finalUrl?: string;
  contentType?: string;
  kind: MediaKind;
  bytes?: number;
  sha256?: string;
  path?: string;
  stored: boolean;
  note?: string;
  error?: string;
}

export interface MediaStats {
  urls: number;
  withFinalStatus: number;
  stored: number;
  imageUrls: number;
  imagesStored: number;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|heic|bmp|svg)(\?|#|$)/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m3u8)(\?|#|$)/i;

export function kindOf(url: string, contentType?: string): MediaKind {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/') || ct.includes('mpegurl')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct === 'application/pdf') return 'document';
  if (ct) return 'other';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {}
  if (IMAGE_EXT.test(url) || host === 'imagedelivery.net' || host === 'i.imgur.com') return 'image';
  if (VIDEO_EXT.test(url) || host.startsWith('stream.')) return 'video';
  return 'other';
}

const STORE_KINDS = new Set<MediaKind>(['image', 'video', 'audio', 'document']);

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const g = ipv6Groups(ip);
    const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
    // IPv4 inside IPv6: mapped (::ffff:a.b.c.d, which URLs spell ::ffff:7f00:1) and NAT64 (64:ff9b::/96).
    if ((zero(0, 5) && g[5] === 0xffff) || (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6))) return isPrivateAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    if (zero(0, 6)) return true; // the rest of ::/96: unspecified, loopback, the old IPv4-compatible form
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || g[0] >= 0xff00; // unique local, link-local, multicast
  }
  return false;
}

// The eight 16-bit groups of a valid IPv6 address; a trailing dotted IPv4 part becomes the last two.
function ipv6Groups(ip: string): number[] {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const v4 = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(2).map(Number);
    s = `${v4[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const zeros = s.includes('::') ? 8 - h.length - t.length : 0;
  return [...h, ...Array<string>(zeros).fill('0'), ...t].map((x) => parseInt(x, 16));
}

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

async function checkUrl(raw: string, resolve: Resolver): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`refused scheme ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('refused host localhost');
  const addrs = net.isIP(host) ? [host] : await resolve(host);
  if (addrs.some(isPrivateAddress)) throw new Error(`refused private address for ${host}`);
  return u;
}

// net.connect's lookup for media requests. The address check and the connection share one DNS answer,
// so a host can't pass checkUrl with a public address and then be reached at a private one.
function checkedLookup(resolve: Resolver, refuse: (ip: string) => boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addrs) => {
        const found = addrs.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 })).filter((a) => !options.family || a.family === options.family);
        if (addrs.some(refuse)) callback(new Error(`refused private address for ${hostname}`), '');
        else if (!found.length) callback(new Error(`no address for ${hostname}`), '');
        else if (options.all) callback(null, found);
        else callback(null, found[0].address, found[0].family);
      },
      (e: Error) => callback(e, ''),
    );
  };
}

// fetch() for media over node:http(s), connecting through checkedLookup; fetch() itself would look the
// host up again. It sends fetch()'s user-agent and asks for the body unencoded: nothing here decodes one,
// so an encoded body is refused. `refuse` is replaceable only so tests can reach a local server.
export function checkedFetch(resolve: Resolver, refuse: (ip: string) => boolean = isPrivateAddress): typeof fetch {
  return ((url: URL, init: RequestInit = {}) =>
    new Promise<Response>((ok, fail) => {
      const headers = { 'user-agent': 'node', ...Object.fromEntries(new Headers(init.headers)), 'accept-encoding': 'identity' };
      const req = (url.protocol === 'https:' ? https : http).request(url, { headers, lookup: checkedLookup(resolve, refuse), signal: init.signal ?? undefined }, (res) => {
        try {
          const encoding = res.headers['content-encoding'];
          if (encoding && encoding.toLowerCase() !== 'identity') throw new Error(`refused content-encoding ${encoding}`);
          const out = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          const status = res.statusCode ?? 0;
          const empty = status === 204 || status === 205 || status === 304; // a Response can't carry a body for these
          if (empty) res.resume();
          ok(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), { status, headers: out }));
        } catch (e) {
          res.destroy();
          fail(e);
        }
      });
      req.on('error', fail);
      req.end();
    })) as typeof fetch;
}

async function readCapped(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > MAX_BYTES) throw new Error(`larger than ${MAX_BYTES} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function downloadMedia(
  refs: MediaRef[],
  writer: ExportWriter,
  opts: { fetchImpl?: typeof fetch; resolve?: Resolver; log?: (s: string) => void; wait?: (ms: number) => Promise<void>; maxTotalBytes?: number } = {},
): Promise<{ rows: MediaIndexRow[]; stats: MediaStats; interrupted: boolean }> {
  const resolve = opts.resolve ?? defaultResolver;
  const fetchImpl = opts.fetchImpl ?? checkedFetch(resolve);
  const wait = opts.wait ?? sleep;
  const byUrl = new Map<string, string[]>();
  const originsByUrl = new Map<string, MediaOrigin[]>();
  for (const r of refs) {
    const list = byUrl.get(r.url) ?? [];
    if (!list.includes(r.castHash)) list.push(r.castHash);
    byUrl.set(r.url, list);
    const origins = originsByUrl.get(r.url) ?? [];
    if (!origins.includes(r.origin ?? 'own')) origins.push(r.origin ?? 'own');
    originsByUrl.set(r.url, origins);
  }
  const maxTotal = opts.maxTotalBytes ?? MAX_TOTAL_BYTES;
  let storedBytes = 0;
  let capLogged = false;
  const lastByHost = new Map<string, number>();
  const rows: MediaIndexRow[] = [];
  for (const [url, castHashes] of byUrl) {
    if (interrupt.requested) break;
    const row: MediaIndexRow = { url, castHashes, origins: originsByUrl.get(url) ?? ['own'], status: null, kind: kindOf(url), stored: false };
    rows.push(row);
    if (storedBytes >= maxTotal) {
      if (!capLogged) opts.log?.(`  media: stored media reached ${maxTotal} bytes; skipping the remaining ${byUrl.size - rows.length + 1} URLs`);
      capLogged = true;
      row.error = `skipped: stored media reached ${maxTotal} bytes`;
      continue;
    }
    try {
      let current = await checkUrl(url, resolve);
      let res: Response | undefined;
      for (let hop = 0; ; hop++) {
        const gap = (lastByHost.get(current.host) ?? 0) + PER_HOST_GAP_MS - Date.now();
        if (gap > 0) await wait(gap);
        lastByHost.set(current.host, Date.now());
        res = await fetchImpl(current, { redirect: 'manual', headers: { accept: 'image/*,video/*,audio/*,*/*;q=0.5' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        const loc = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && loc) {
          await res.body?.cancel();
          if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
          current = await checkUrl(new URL(loc, current).toString(), resolve);
          continue;
        }
        break;
      }
      row.status = res.status;
      row.finalUrl = current.toString() === url ? undefined : current.toString();
      row.contentType = res.headers.get('content-type') ?? undefined;
      // Only a 200 body says what the URL is; an error page's content type must not turn a missing
      // image into "other" (that would hide it from AC-19's image count).
      if (res.status === 200) row.kind = kindOf(url, row.contentType);
      if (res.status !== 200) {
        await res.body?.cancel();
        continue;
      }
      if (!STORE_KINDS.has(row.kind)) {
        await res.body?.cancel();
        row.note = 'not-media';
        continue;
      }
      const buf = await readCapped(res);
      const sha = createHash('sha256').update(buf).digest('hex');
      const rel = `media/sha256/${sha.slice(0, 2)}/${sha}`;
      if (!writer.exists(rel)) {
        writer.write(rel, buf);
        storedBytes += buf.length;
      }
      Object.assign(row, { bytes: buf.length, sha256: sha, path: rel, stored: true });
      if (row.contentType?.includes('mpegurl')) row.note = 'hls-playlist-only:segments-not-fetched';
    } catch (e) {
      row.error = errMessage(e);
    }
  }
  return { rows, stats: mediaStats(rows, byUrl.size), interrupted: rows.length < byUrl.size };
}

// urls: distinct URLs requested (pass rows.length when the requested total is not known separately).
export function mediaStats(rows: MediaIndexRow[], urls = rows.length): MediaStats {
  return {
    urls,
    withFinalStatus: rows.filter((r) => r.status !== null || r.error).length,
    stored: rows.filter((r) => r.stored).length,
    imageUrls: rows.filter((r) => r.kind === 'image').length,
    imagesStored: rows.filter((r) => r.kind === 'image' && r.stored).length,
  };
}
