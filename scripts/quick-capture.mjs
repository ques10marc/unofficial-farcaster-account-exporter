#!/usr/bin/env node
// Quick capture: saves verbatim pages from the Farcaster client API to a local folder,
// as a quick first copy before a full castsnap export. Zero dependencies; Node >= 20.
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
// Network errors (no response, or a body that fails mid-read) are retried with waits of 2, 4, 8, 16, 32
// and then 60 s: about 5 minutes in all, enough to ride out a Wi-Fi reconnect.
const NETWORK_ATTEMPTS = 10;
const MAX_ERROR_CHARS = 300;

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
// The forms the token could take if it leaked, as in src/secrets.ts: verbatim, URL-encoded, base64, hex.
const tokenForms = () => (TOKEN ? [...new Set([TOKEN, encodeURIComponent(TOKEN), Buffer.from(TOKEN).toString('base64'), Buffer.from(TOKEN).toString('hex')])] : []);
const redact = (s) => tokenForms().reduce((out, v) => out.split(v).join('[REDACTED]'), String(s));
// Redacted first, then cut, so a cut can never leave part of the token behind.
const safeError = (e) => {
  const s = redact(e instanceof Error ? e.message : e);
  return s.length > MAX_ERROR_CHARS ? `${s.slice(0, MAX_ERROR_CHARS)}…` : s;
};

function normalizeToken(raw) {
  return raw
    .replace(/\x1b\[20[01]~/g, '') // bracketed-paste markers
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^authorization:\s*/i, '')
    .replace(/^bearer\s+/i, '')
    .trim();
}

// One text twice over ("XX"), as when a paste is repeated because nothing appeared; as in src/secrets.ts.
const pastedTwice = (s) => { const t = s.replace(/\x1b\[20[01]~/g, '').trim(); const half = t.length / 2; return t.length >= 2 && Number.isInteger(half) && t.slice(0, half) === t.slice(half); };
const chars = (n) => `${n} character${n === 1 ? '' : 's'}`;
// Input that arrives within this many ms of the prompt taking the terminal was typed or pasted before the
// question appeared, so the terminal may have shown it: it is discarded and counted, never used.
const EARLY_INPUT_MS = 200;

function promptHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new Error('No terminal for a hidden prompt; set FC_SESSION_TOKEN instead.'));
  return new Promise((resolve, reject) => {
    let buf = '';
    let early = 0;
    let ready = false;
    let timer;
    // After Enter, only the number of characters received is shown, never the characters.
    const finish = (err) => {
      clearTimeout(timer); stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause();
      process.stdout.write(err ? '\n' : `${chars([...buf].length)} received.\n`);
      if (err) reject(err); else resolve(buf);
    };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\u0003') { finish(new Error('Cancelled')); return; }
        if (!ready) { early++; continue; }
        if (c === '\r' || c === '\n') { finish(); return; }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
    timer = setTimeout(() => {
      ready = true;
      if (early) process.stdout.write(`Ignored ${chars(early)} typed or pasted before this prompt was ready. They may have been shown on screen; if that was your token, clear the terminal's scrollback.\n`);
      process.stdout.write(question);
    }, EARLY_INPUT_MS);
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
    let text;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      // The timeout also covers the body, so a connection that dies mid-body is retried like one that
      // never answered.
      text = await res.text();
    } catch (e) {
      if (attempt >= NETWORK_ATTEMPTS || interrupted) return { status: 0, text: '', error: safeError(e) };
      const ms = Math.min(60_000, 2000 * 2 ** (attempt - 1));
      log(`    network error, retry ${attempt} in ${Math.round(ms / 1000)}s: ${safeError(e)}`);
      await backoffSleep(ms);
      continue;
    }
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
    const typed = process.env.FC_SESSION_TOKEN || (await promptHidden('Paste session token (input hidden), then Enter: '));
    TOKEN = normalizeToken(typed);
    if (!TOKEN) throw new Error('Empty token.');
    if (pastedTwice(typed) || pastedTwice(TOKEN)) throw new Error('The token looks pasted twice (the same text two times in a row); run the command again and paste it once.');
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
    // A rejected token may be one pasted twice; saying so first spares a needless new sign-in.
    const advice = me.status === 401 || me.status === 403 ? 'If you pasted more than once, run the command again and paste once. If it still fails, copy a fresh token and retry.' : 'Copy a fresh token and retry.';
    if (me.status !== 200) throw new Error(`Token check failed: /v2/me returned HTTP ${me.status}. ${advice}`);
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
  const scan = () => listFiles(OUT_DIR).filter((f) => { const buf = fs.readFileSync(path.join(OUT_DIR, f)); return tokenForms().some((v) => buf.includes(v)); });
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
