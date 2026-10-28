#!/usr/bin/env node
// Quick capture: saves verbatim pages from the Farcaster client API to a local folder,
// as a quick first copy before a full fcx export. Zero dependencies; Node >= 20.
//
// Usage:
//   node scripts/quick-capture.mjs                         # prompts for your session token (hidden)
//   FC_SESSION_TOKEN=... node scripts/quick-capture.mjs    # token from env instead
//   node scripts/quick-capture.mjs --public-only --fid 1   # no token; public endpoints only
// Options: --out DIR (default ~/FarcasterExports)  --base URL (default https://client.farcaster.xyz,
//          falling back to the web app's proxy https://farcaster.xyz/~api if the token is rejected)
//
// Endpoint paths, auth and page sizes come from the official client's API definitions:
// github.com/farcasterxyz/client packages/farcaster-client-data/bin/types.yml (snapshot 2026-09-30).
// The token is never written to disk or printed. stdout shows aggregate counts only.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '0.1.0';
const MIN_GAP_MS = 600; // /v2/following and /v2/followers allow 20 requests per 10s
const REQUEST_TIMEOUT_MS = 30_000;

// ---------- args ----------
function parseArgs(argv) {
  const args = { out: path.join(os.homedir(), 'FarcasterExports'), base: 'https://client.farcaster.xyz' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--public-only') args.publicOnly = true;
    else if (a === '--fid') args.fid = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--base') { args.base = argv[++i].replace(/\/+$/, ''); args.baseExplicit = true; }
    else if (a === '--help' || a === '-h') args.help = true;
    // Named only if it looks like a flag: anything else may be a token pasted in the wrong place.
    else throw new Error(/^-{0,2}[A-Za-z][A-Za-z-]{0,30}$/.test(a) ? `Unknown argument: ${a}` : 'Unknown argument, not shown in case it is your session token. If it is, it is now saved in your shell history: delete it from there, and paste the token only at the hidden prompt.');
  }
  if (args.fid !== undefined && !(Number.isInteger(args.fid) && args.fid > 0)) throw new Error('--fid must be a positive integer');
  if (args.publicOnly && !args.fid) throw new Error('--public-only needs --fid');
  return args;
}

// ---------- token ----------
let TOKEN = '';
const redact = (s) => (TOKEN ? String(s).split(TOKEN).join('[REDACTED]') : String(s));

function normalizeToken(raw) {
  return raw
    .replace(/\x1b\[20[01]~/g, '') // bracketed-paste markers
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^authorization:\s*/i, '')
    .replace(/^bearer\s+/i, '')
    .trim();
}

function promptHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new Error('No terminal for a hidden prompt; set FC_SESSION_TOKEN instead.'));
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    let buf = '';
    const cleanup = () => { stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') { cleanup(); resolve(buf); return; }
        if (c === '\u0003') { cleanup(); reject(new Error('Cancelled')); return; }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

// ---------- output ----------
let OUT_DIR = '';
function writeFile(rel, text) {
  const p = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, text, { mode: 0o600 });
}
function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p)];
  }).sort();
}
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

// ---------- http ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Backoff waits end early on Ctrl-C so the manifest still gets written promptly.
async function backoffSleep(ms) {
  const end = Date.now() + ms;
  while (!interrupted && Date.now() < end) await sleep(Math.min(500, end - Date.now()));
}
let lastRequestAt = 0;
let interrupted = false;

async function request(urlPath, params, { auth }) {
  const url = new URL(args.base + urlPath);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const headers = { accept: 'application/json' };
  if (auth) headers.authorization = `Bearer ${TOKEN}`;

  let backoff = 0;
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      if (attempt >= 6 || interrupted) return { status: 0, text: '', error: redact(e.message) };
      await backoffSleep(Math.min(60_000, 2000 * 2 ** (attempt - 1)));
      continue;
    }
    const text = await res.text();
    if (res.status === 429 && attempt <= 12) {
      const ra = Number(res.headers.get('retry-after'));
      backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(15 * 60_000, Math.max(30_000, backoff * 2));
      log(`    rate limited (429); waiting ${Math.round(backoff / 1000)}s`);
      await backoffSleep(backoff);
      if (interrupted) return { status: 0, text: '', error: 'interrupted' };
      continue;
    }
    if (res.status >= 500 && attempt < 6 && !interrupted) { await backoffSleep(Math.min(60_000, 2000 * 2 ** (attempt - 1))); continue; }
    return { status: res.status, text };
  }
}

// ---------- capture ----------
const manifest = { tool: 'quick-capture', version: VERSION, schema: 1, endpoints: {} };
const log = (s) => process.stdout.write(redact(s) + '\n');

// Fetch every page of one endpoint. Saves each response body verbatim.
async function capture(name, urlPath, { params = {}, auth = false, itemsKey, limit, paginated = true, dir = name }) {
  const entry = { path: urlPath, params, auth, pages: 0, items: 0, lastCursorEmpty: null, status: 'error:not-started' };
  manifest.endpoints[name] = entry;
  if (auth && !TOKEN) { entry.status = 'skipped:public-only'; return { ...entry, results: [] }; }

  const limits = paginated ? [limit, 15, undefined].filter((v, i, a) => a.indexOf(v) === i) : [undefined];
  let limitIdx = 0;
  let cursor;
  const seen = new Set();
  const results = [];
  while (!interrupted) {
    const q = { ...params };
    if (paginated && limits[limitIdx] !== undefined) q.limit = limits[limitIdx];
    if (cursor) q.cursor = cursor;
    const r = await request(urlPath, q, { auth });
    if (r.status === 400 && entry.pages === 0 && limitIdx < limits.length - 1) { limitIdx++; continue; }
    if (r.status !== 200) {
      if (interrupted) break;
      entry.status = r.status === 0 ? `error:network:${r.error}` : `unavailable:${r.status}`;
      if (r.text) writeFile(`${dir}/error-${String(entry.pages + 1).padStart(4, '0')}.json`, redact(r.text).slice(0, 4000));
      return { ...entry, results };
    }
    entry.pages++;
    writeFile(`${dir}/page-${String(entry.pages).padStart(4, '0')}.json`, r.text);
    let body;
    try { body = JSON.parse(r.text); } catch { entry.status = 'error:non-json'; return { ...entry, results }; }
    const items = itemsKey ? body?.result?.[itemsKey] : undefined;
    if (Array.isArray(items)) { entry.items += items.length; results.push(...items); }
    if (paginated && limits[limitIdx] !== undefined) entry.limitUsed = limits[limitIdx];
    const next = body?.next?.cursor;
    if (!paginated || !next) { entry.lastCursorEmpty = true; entry.status = entry.items === 0 && itemsKey ? 'empty' : 'complete'; return { ...entry, results }; }
    if (seen.has(next)) { entry.status = 'error:cursor-loop'; entry.lastCursorEmpty = false; return { ...entry, results }; }
    seen.add(next);
    cursor = next;
  }
  entry.status = 'interrupted';
  entry.lastCursorEmpty = false;
  return { ...entry, results };
}

function summarize(name) {
  const e = manifest.endpoints[name];
  log(`  ${name.padEnd(28)} ${String(e.status).padEnd(22)} pages=${e.pages} items=${e.items}`);
}

async function main() {
  if (args.help) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 11).join('\n')); return 0; }

  if (!args.publicOnly) {
    TOKEN = normalizeToken(process.env.FC_SESSION_TOKEN || (await promptHidden('Paste session token (input hidden), then Enter: ')));
    if (!TOKEN) throw new Error('Empty token.');
  }

  // Identify the account before writing anything.
  let fid = args.fid;
  let username;
  let meText;
  if (TOKEN) {
    let me = await request('/v2/me', {}, { auth: true });
    if ((me.status === 401 || me.status === 403) && !args.baseExplicit) {
      const primary = args.base;
      args.base = 'https://farcaster.xyz/~api'; // the host the web app itself calls
      me = await request('/v2/me', {}, { auth: true });
      if (me.status !== 200) args.base = primary;
    }
    if (me.status !== 200) throw new Error(`Token check failed: /v2/me returned HTTP ${me.status}. Copy a fresh token and retry.`);
    const user = JSON.parse(me.text)?.result?.user;
    if (!Number.isInteger(user?.fid)) throw new Error('Unexpected /v2/me response shape (no user.fid).');
    if (args.fid && args.fid !== user.fid) throw new Error(`Token belongs to fid ${user?.fid}, not --fid ${args.fid}.`);
    fid = user?.fid;
    username = user?.username;
    meText = me.text;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  fs.mkdirSync(args.out, { recursive: true, mode: 0o700 });
  OUT_DIR = path.join(args.out, `quick-${fid}-${stamp}`);
  fs.mkdirSync(OUT_DIR, { mode: 0o700 });
  fs.chmodSync(OUT_DIR, 0o700);
  Object.assign(manifest, { fid, username, base: args.base, mode: TOKEN ? 'private' : 'public-only', node: process.version, startedAt: new Date().toISOString() });
  log(`Account: fid ${fid}${username ? ` (@${username})` : ''}`);
  log(`Output:  ${OUT_DIR}`);
  if (meText) { writeFile('me/page-0001.json', meText); manifest.endpoints.me = { path: '/v2/me', auth: true, pages: 1, items: 1, lastCursorEmpty: true, status: 'complete' }; }

  const onSigint = () => { if (interrupted) process.exit(130); interrupted = true; log('\nInterrupted: finishing the current request, then writing the manifest...'); };
  process.on('SIGINT', onSigint);

  // Order: data that exists only on the flagship server first; rate-limited follow lists last.
  log('Capturing:');
  await capture('profile-before', '/v2/user-by-fid', { params: { fid }, paginated: false }); summarize('profile-before');
  await capture('bookmarks', '/v2/bookmarked-casts', { auth: true, itemsKey: 'bookmarks', limit: 100 }); summarize('bookmarks');

  // Direct casts: conversation lists per category, then every conversation's messages.
  const convIds = new Set();
  for (const category of ['default', 'archived', 'request', 'void']) {
    const name = `dm-conversations-${category}`;
    const r = await capture(name, '/v2/direct-cast-conversation-list', { params: { category }, auth: true, itemsKey: 'conversations', limit: 50 });
    for (const c of r.results) if (c?.conversationId) convIds.add(c.conversationId);
    summarize(name);
  }
  const dm = { path: '/v2/direct-cast-conversation-messages', auth: true, conversations: convIds.size, complete: 0, notComplete: [], pages: 0, items: 0 };
  for (const id of convIds) {
    if (interrupted) break;
    const key = `dm-messages/${safeName(id)}`;
    const r = await capture(key, '/v2/direct-cast-conversation-messages', { params: { conversationId: id }, auth: true, itemsKey: 'messages', limit: 50 });
    delete manifest.endpoints[key];
    dm.pages += r.pages; dm.items += r.items;
    if (r.status === 'complete' || r.status === 'empty') dm.complete++; else dm.notComplete.push({ dir: key, status: r.status });
  }
  dm.status = !TOKEN ? 'skipped:public-only' : interrupted ? 'interrupted' : dm.notComplete.length ? `partial:${dm.notComplete.length}-not-complete` : convIds.size ? 'complete' : 'empty';
  dm.lastCursorEmpty = TOKEN ? dm.notComplete.length === 0 && !interrupted : null;
  manifest.endpoints['dm-messages'] = dm;
  summarize('dm-messages');

  await capture('drafts', '/v2/draft-casts', { auth: true, itemsKey: 'drafts', limit: 50 }); summarize('drafts');
  await capture('muted-keywords', '/v2/get-muted-keywords', { auth: true, paginated: false }); summarize('muted-keywords');
  await capture('muted-users', '/v2/get-muted-users', { auth: true, itemsKey: 'mutedUsers', limit: 50 }); summarize('muted-users');
  await capture('muted-channels', '/v2/get-muted-channels', { auth: true, paginated: false }); summarize('muted-channels');
  await capture('favorite-mini-apps', '/v1/favorite-frames', { auth: true, itemsKey: 'frames', limit: 50 }); summarize('favorite-mini-apps');
  await capture('channels-following', '/v1/user-following-channels', { params: { fid }, itemsKey: 'channels', limit: 50 }); summarize('channels-following');
  await capture('blocked-users', '/fc/blocked-users', { params: { blockerFid: fid }, itemsKey: 'blockedUsers', limit: 1000 }); summarize('blocked-users');
  await capture('following', '/v2/following', { params: { fid }, itemsKey: 'users', limit: 50 }); summarize('following');
  await capture('followers', '/v2/followers', { params: { fid }, itemsKey: 'users', limit: 50 }); summarize('followers');
  await capture('profile-after', '/v2/user-by-fid', { params: { fid }, paginated: false }); summarize('profile-after');

  manifest.finishedAt = new Date().toISOString();
  manifest.interrupted = interrupted;

  // Token self-scan over everything written, then checksums.
  const scan = () => listFiles(OUT_DIR).filter((f) => TOKEN && fs.readFileSync(path.join(OUT_DIR, f), 'utf8').includes(TOKEN));
  writeFile('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  const hits = scan();
  manifest.tokenSelfScan = { filesScanned: listFiles(OUT_DIR).length, filesWithToken: hits.length, ran: Boolean(TOKEN) };
  writeFile('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  const sums = listFiles(OUT_DIR).map((f) => `${createHash('sha256').update(fs.readFileSync(path.join(OUT_DIR, f))).digest('hex')}  ${f}`);
  writeFile('SHA256SUMS', sums.join('\n') + '\n');

  const unrecorded = Object.entries(manifest.endpoints).filter(([, e]) => !e.status || e.status === 'error:not-started');
  log(`Files: ${sums.length} (+SHA256SUMS). Verify later with: cd "${OUT_DIR}" && shasum -a 256 -c SHA256SUMS`);
  log(TOKEN ? `Token self-scan: ${hits.length} file(s) contain the token${hits.length ? ' -- DELETE THIS FOLDER and report it' : ''}.` : 'Token self-scan: not applicable (public-only run).');
  if (hits.length) return 2;
  if (interrupted) return 130;
  if (unrecorded.length) return 1;
  return 0;
}

const args = (() => {
  try { return parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(64); }
})();
// The last resort for errors, including any thrown outside main()'s promise chain, which Node would
// otherwise print unredacted.
const crash = (e) => { console.error(`Error: ${redact(e instanceof Error ? e.message : e)}`); process.exit(1); };
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
main().then((code) => process.exit(code), crash);
