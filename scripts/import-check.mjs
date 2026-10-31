#!/usr/bin/env node
// Offline import check (SPEC AC-15): rebuilds following, followers and (on --private runs) bookmarks
// with cast text from an export directory alone, the way another tool importing the export would.
// Independent of castsnap's own code: only node builtins and @farcaster/core (to decode raw protobuf).
// Any network attempt throws; run it under `sandbox-exec -p '(version 1)(allow default)(deny network*)'`
// on macOS to have the OS enforce that too.
//
// Usage: node scripts/import-check.mjs <export-dir>      exit 0 when every rebuild agrees

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Message, MessageType } from '@farcaster/core';

const refuse = () => {
  throw new Error('import-check attempted network access');
};
globalThis.fetch = refuse;
net.connect = refuse;
net.createConnection = refuse;

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/import-check.mjs <export-dir>');
  process.exit(64);
}
const p = (rel) => path.join(dir, rel);
const has = (rel) => fs.existsSync(p(rel));

function decodeDelimited(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let len = 0;
    let shift = 0;
    for (;;) {
      const b = buf[i++];
      len += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) break;
      shift += 7;
    }
    out.push(buf.subarray(i, i + len));
    i += len;
  }
  return out;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, k) => [h, r[k]])));
}

const messages = (file) => (has(`raw/protocol/${file}.pb`) ? decodeDelimited(fs.readFileSync(p(`raw/protocol/${file}.pb`))).map((b) => Message.decode(b)) : []);
const fid = JSON.parse(fs.readFileSync(p('manifest.json'), 'utf8')).fid;
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const lines = [`import-check ${path.resolve(dir)} (fid ${fid}, offline)`];
let ok = true;

// Following: the FID's own LINK_ADD(follow) messages, plus targets of a compact-state message that no
// later LINK_REMOVE undoes.
const links = messages('links');
const followRaw = new Set();
const removedAt = new Map();
for (const m of links) {
  const d = m.data;
  if (d?.type === MessageType.LINK_REMOVE && d.linkBody?.type === 'follow') removedAt.set(d.linkBody.targetFid, d.timestamp);
  if (d?.type === MessageType.LINK_ADD && d.linkBody?.type === 'follow') followRaw.add(d.linkBody.targetFid);
}
for (const m of [...messages('link-compact-state'), ...links.filter((x) => x.data?.type === MessageType.LINK_COMPACT_STATE)]) {
  const b = m.data?.linkCompactStateBody;
  if (b?.type !== 'follow') continue;
  for (const t of b.targetFids) if (!((removedAt.get(t) ?? -1) > m.data.timestamp)) followRaw.add(t);
}

// Followers: other FIDs' LINK_ADD(follow) messages that target this FID.
const followerRaw = new Set();
for (const m of messages('followers')) {
  const d = m.data;
  if (d?.type === MessageType.LINK_ADD && d.linkBody?.type === 'follow' && d.linkBody.targetFid === fid) followerRaw.add(d.fid);
}

for (const [name, raw] of [['following', followRaw], ['followers', followerRaw]]) {
  const csv = parseCsv(fs.readFileSync(p(`csv/${name}.csv`), 'utf8'));
  const norm = JSON.parse(fs.readFileSync(p(`normalized/${name}.json`), 'utf8')).records;
  const csvProto = new Set(csv.filter((r) => r.in_protocol === 'true').map((r) => Number(r.fid)));
  const normProto = new Set(norm.filter((r) => r.inProtocol).map((r) => r.fid));
  const csvClientOnly = new Set(csv.filter((r) => r.in_protocol !== 'true').map((r) => Number(r.fid)));
  const normClientOnly = new Set(norm.filter((r) => !r.inProtocol).map((r) => r.fid));
  const agree = sameSet(raw, csvProto) && sameSet(raw, normProto) && sameSet(csvClientOnly, normClientOnly);
  ok &&= agree;
  lines.push(`  ${name.padEnd(10)} raw protobuf ${raw.size} · csv (in_protocol) ${csvProto.size} · normalized (inProtocol) ${normProto.size} · client-only csv ${csvClientOnly.size} / normalized ${normClientOnly.size} · ${agree ? 'AGREE' : 'DISAGREE'}`);
}

// Bookmarks (--private runs): rebuilt from the verbatim client pages alone, then compared, in order,
// with the normalized file and the CSV (hash, author and cast text).
if (has('raw/client/bookmarks')) {
  const pages = fs.readdirSync(p('raw/client/bookmarks')).filter((f) => /^page-\d{4}\.json$/.test(f)).sort();
  const raw = pages.flatMap((f) => JSON.parse(fs.readFileSync(p(`raw/client/bookmarks/${f}`), 'utf8')).result?.bookmarks ?? []);
  const rebuilt = raw.map((b) => ({ hash: typeof b?.hash === 'string' ? b.hash.toLowerCase() : null, fid: b?.author?.fid ?? null, text: typeof b?.text === 'string' ? b.text : null }));
  const norm = has('normalized/bookmarks.json') ? JSON.parse(fs.readFileSync(p('normalized/bookmarks.json'), 'utf8')).records : [];
  const csv = has('csv/bookmarks.csv') ? parseCsv(fs.readFileSync(p('csv/bookmarks.csv'), 'utf8')) : [];
  const withText = rebuilt.filter((r) => r.hash && r.text !== null).length;
  const normAgree = norm.length === rebuilt.length && rebuilt.every((r, i) => norm[i].hash === r.hash && norm[i].fid === r.fid && norm[i].text === r.text);
  const csvAgree = csv.length === rebuilt.length && rebuilt.every((r, i) => csv[i].hash === r.hash && Number(csv[i].author_fid) === r.fid && csv[i].text === r.text);
  const agree = withText === rebuilt.length && normAgree && csvAgree;
  ok &&= agree;
  lines.push(`  bookmarks  raw pages ${rebuilt.length} · with hash and cast text ${withText} · normalized ${norm.length} (${normAgree ? 'same' : 'DIFFERENT'}) · csv ${csv.length} (${csvAgree ? 'same' : 'DIFFERENT'}) · ${agree ? 'AGREE' : 'DISAGREE'}`);
} else lines.push('  bookmarks  not in this export (not a --private run)');

lines.push(`Result: ${ok ? 'PASS' : 'FAIL'}`);
console.log(lines.join('\n'));
process.exit(ok ? 0 : 1);
