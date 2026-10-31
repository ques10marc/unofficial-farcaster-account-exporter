// Private adapter (--private): token handling, host choice, the private endpoints over real HTTP against a
// local mock server, and verify's private criteria. No real token is used and no request leaves
// 127.0.0.1: the sentinel token is random per run, so it never exists in the repo.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Message } from '@farcaster/core';
import { ClientApi } from '../src/client.ts';
import { parseCsv } from '../src/csv.ts';
import { AuthCheckError, laneAbortStatus } from '../src/export.ts';
import { findInExport } from '../src/find.ts';
import { checkTokenShape, normalizeToken, readSessionToken, redactRegistered, scanTreeForSecret, tokenHostAllowed } from '../src/secrets.ts';
import { RateLimiter, toHex } from '../src/util.ts';
import { verifyExport } from '../src/verify.ts';
import { decodeDelimited } from '../src/writer.ts';
import { replayExport, tmpDir } from './helpers.ts';
import { startMock } from './mock-server.ts';
import { buildPrivateFixture } from './private-fixtures.ts';
import { mockPrivateExport } from './private-run.ts';

const repo = path.join(import.meta.dirname, '..');
const sentinel = () => `castsnap-sentinel-${randomUUID()}`;
const noLimit = () => new RateLimiter({ windows: [] });
const PRIVATE_PATHS = ['/v2/me', '/v2/bookmarked-casts', '/v2/direct-cast-conversation-list', '/v2/direct-cast-conversation-messages', '/v2/draft-casts', '/v2/get-muted-keywords', '/v2/get-muted-users', '/v2/get-muted-channels', '/v1/favorite-frames'];
const verdicts = (checks: { id: string; verdict: string }[]) => Object.fromEntries(checks.map((c) => [c.id, c.verdict]));
const exportDirs = (out: string) => (fs.existsSync(out) ? fs.readdirSync(out).filter((f) => f.startsWith('fc-export-')) : []);

// ---------- token handling ----------

test('token: "Authorization:", "Bearer", quotes and bracketed-paste markers are stripped', () => {
  const t = 'MK-abcdefghijklmnopqrstuvwxyz0123456789';
  for (const raw of [t, `Bearer ${t}`, `bearer ${t}`, `Authorization: Bearer ${t}`, `authorization:Bearer ${t}`, `"Bearer ${t}"`, `\x1b[200~Bearer ${t}\x1b[201~`, `  ${t}\r\n`]) assert.equal(normalizeToken(raw), t, JSON.stringify(raw));
});

test('token: spaces, control characters and empty values are refused without echoing the token', async () => {
  const t = sentinel();
  assert.match(checkTokenShape(`${t} extra`)!, /spaces or non-printable/);
  assert.match(checkTokenShape(`${t}\u0000`)!, /non-printable/);
  assert.match(checkTokenShape('')!, /empty/);
  assert.equal(checkTokenShape(t), null);
  await assert.rejects(readSessionToken({ env: { FC_SESSION_TOKEN: `Bearer ${t} ${t}` } }), (e: Error) => !e.message.includes(t) && /not usable/.test(e.message));
  // The refused value and its parts are still registered, so a last-resort error handler redacts them.
  assert.ok(!redactRegistered(`oops ${t} ${t}`).includes(t));
  assert.equal(redactRegistered(`oops ${t}`), 'oops [REDACTED]');
});

test('token: FC_SESSION_TOKEN first, else the hidden prompt; no terminal is an error, not a hang', async () => {
  const t = sentinel();
  assert.deepEqual(await readSessionToken({ env: { FC_SESSION_TOKEN: `Bearer ${t}` } }), { token: t, from: 'env' });
  assert.deepEqual(await readSessionToken({ env: {}, prompt: async () => `Authorization: Bearer ${t}` }), { token: t, from: 'prompt' });
  // node --test runs files without a TTY on stdin, so the real prompt must refuse.
  await assert.rejects(readSessionToken({ env: {} }), /No terminal for a hidden prompt; set FC_SESSION_TOKEN/);
});

test('token hosts: only the official client hosts and loopback mocks', () => {
  for (const ok of ['https://client.farcaster.xyz', 'https://client.farcaster.xyz/', 'https://farcaster.xyz/~api', 'http://127.0.0.1:8080', 'http://localhost:3000/~api', 'http://[::1]:9000']) assert.equal(tokenHostAllowed(ok), true, ok);
  for (const bad of ['http://client.farcaster.xyz', 'https://client.farcaster.xyz.evil.example', 'https://evil.example', 'https://farcaster.xyz', 'https://farcaster.xyz/~apix', 'https://farcaster.xyz/api', 'https://user:pw@client.farcaster.xyz', 'https://client.farcaster.xyz?x=1', 'https://snap.farcaster.xyz:3381', 'ftp://127.0.0.1', 'not a url']) assert.equal(tokenHostAllowed(bad), false, bad);
});

// ---------- ClientApi with a token ----------

test('a token is sent only on private requests, never to a host outside the allow-list, and redirects are not followed', async () => {
  const t = sentinel();
  const calls: { url: string; auth: string | null; redirect?: RequestInit['redirect'] }[] = [];
  const fetchImpl = (async (u: URL, init: RequestInit) => {
    calls.push({ url: u.toString(), auth: new Headers(init.headers).get('authorization'), redirect: init.redirect });
    if (u.pathname.endsWith('/v2/bookmarked-casts')) return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
    return new Response(JSON.stringify({ result: { users: [], bookmarks: [] } }), { status: 200 });
  }) as typeof fetch;
  const api = new ClientApi({ token: t, fetchImpl, limiter: noLimit(), privateLimiter: noLimit(), wait: async () => {} });
  await api.paginate('/v2/following', { fid: 1 }, 'users', 50);
  assert.equal(calls[0].auth, null, 'public request carried the token');
  const r = await api.paginate('/v2/bookmarked-casts', {}, 'bookmarks', 100, { auth: true });
  assert.equal(r.status, 'unavailable:302');
  assert.equal(calls[1].auth, `Bearer ${t}`);
  assert.equal(calls[1].redirect, 'manual');
  assert.ok(!calls.some((c) => c.url.includes('evil.example')), 'followed a redirect with the token');

  const evil = new ClientApi({ token: t, bases: ['https://evil.example'], explicitBase: true, fetchImpl, limiter: noLimit(), privateLimiter: noLimit() });
  const before = calls.length;
  const e = await evil.paginate('/v2/bookmarked-casts', {}, 'bookmarks', 100, { auth: true });
  assert.equal(calls.length, before, 'a request was made to a host outside the allow-list');
  assert.match(e.status, /refused to send the session token/);
});

// ---------- auth-check over HTTP ----------

test('auth-check: 401 on the first host falls back to the ~api host; an explicit host never falls back', async () => {
  const t = sentinel();
  for (const status of [401, 403]) {
    const mock = await startMock({ token: t, rejectPrefixes: { primary: status } });
    try {
      const api = new ClientApi({ token: t, bases: [`${mock.url}/primary`, `${mock.url}/~api`], privateLimiter: noLimit() });
      const r = await api.authCheck(11);
      assert.equal(r.ok, true, r.message);
      assert.deepEqual(r.attempts.map((a) => a.status), [status, 200]);
      assert.equal(api.currentBase, `${mock.url}/~api`);
      assert.deepEqual(mock.requests.map((q) => [q.prefix, q.path, q.auth]), [['primary', '/v2/me', 'valid'], ['~api', '/v2/me', 'valid']]);

      const explicit = new ClientApi({ token: t, bases: [`${mock.url}/primary`], explicitBase: true, privateLimiter: noLimit() });
      const x = await explicit.authCheck(11);
      assert.equal(x.ok, false);
      assert.match(x.message, new RegExp(`Token check failed: /v2/me returned HTTP ${status} at`));
      assert.equal(x.attempts.length, 1);
    } finally {
      await mock.close();
    }
  }
});

test('auth-check: a token for another FID is reported, and a rejected token never reaches the message', async () => {
  const t = sentinel();
  const mock = await startMock({ token: t, echoToken: true });
  try {
    const api = new ClientApi({ token: t, bases: [`${mock.url}/~api`], explicitBase: true, privateLimiter: noLimit() });
    const r = await api.authCheck(12);
    assert.equal(r.ok, false);
    assert.equal(r.message, 'The session token belongs to fid 11, not --fid 12.');
    const wrong = sentinel();
    const bad = await new ClientApi({ token: wrong, bases: [`${mock.url}/~api`], explicitBase: true, privateLimiter: noLimit() }).authCheck(11);
    assert.equal(bad.ok, false);
    assert.ok(!bad.message.includes(wrong));
  } finally {
    await mock.close();
  }
});

test('export --private aborts before writing anything when the token is rejected or belongs to another FID', async () => {
  for (const [fid, token] of [[12, undefined], [11, sentinel()]] as const) {
    const out = tmpDir('castsnap-abort-');
    await assert.rejects(
      mockPrivateExport({ out, token, export: { fid, ...(token ? { client: new ClientApi({ token: 'castsnap-sentinel-wrong-token-0000', bases: ['http://127.0.0.1:9/~api'], explicitBase: true, privateLimiter: noLimit(), wait: async () => {} }) } : {}) } }),
      (e: Error) => e instanceof AuthCheckError && /Nothing was written/.test(e.message),
    );
    assert.deepEqual(exportDirs(out), [], `fid ${fid}: an export directory was created`);
  }
});

// ---------- the full private export ----------

test('mock --private export: every automatable check passes, and the token goes only to the client host', async () => {
  let dsStore = '';
  const r = await mockPrivateExport({
    // Finder may write .DS_Store into a folder while the export is still running.
    onMedia: (out) => {
      const dir = path.join(out, exportDirs(out)[0]);
      dsStore = path.join(dir, 'raw/client/bookmarks/.DS_Store');
      fs.writeFileSync(path.join(dir, '.DS_Store'), 'finder');
      fs.writeFileSync(dsStore, 'finder');
    },
  });
  const { result, token, mock, logs, mediaCalls } = r;
  const m = result.manifest;
  assert.equal(result.exitCode, 0, logs.join('\n'));
  assert.equal(m.result, 'ok');
  for (const id of ['D3', 'D10', 'D11', 'D12', 'D13', 'D14']) assert.equal(m.datasets[id].status, 'complete', `${id}: ${m.datasets[id].status}`);
  assert.equal(m.authCheck?.fid, 11);
  assert.deepEqual(m.authCheck?.attempts.map((a) => a.status), [401, 200]);

  // Where the token went: every private request carried exactly it; nothing else carried anything.
  assert.ok(mock.requests.length > 50);
  for (const q of mock.requests) {
    if (PRIVATE_PATHS.includes(q.path)) assert.equal(q.auth, 'valid', `${q.prefix}${q.path}`);
    else assert.equal(q.auth, 'none', `public ${q.path} carried a token`);
  }
  assert.ok(mediaCalls.length > 0);
  for (const c of mediaCalls) assert.equal(c.headers.authorization, undefined, `media ${c.url} carried a token`);
  assert.ok(!JSON.stringify(mediaCalls).includes(token));
  assert.ok(!logs.join('\n').includes(token), 'token in the log');
  assert.equal(scanTreeForSecret(result.dir, token).hits.length, 0, 'token written to the export');

  // Pagination paths: 400 on the first page retried with a smaller limit; 429 honoured.
  assert.deepEqual(m.sources['client:muted-users'].notes, ['limit=15']);
  const frames = mock.requests.filter((q) => q.path === '/v1/favorite-frames').map((q) => q.status);
  assert.deepEqual(frames, [429, 200]);

  // Content: bookmarks with the full cast, DMs per conversation, the rest.
  const exp = mock.data.expect;
  const bm = JSON.parse(fs.readFileSync(path.join(result.dir, 'normalized/bookmarks.json'), 'utf8')).records;
  assert.equal(bm.length, mock.data.bookmarks.length);
  // +1: the fid 999 cast that only the bookmark lookup finds (next test).
  assert.equal(bm.filter((b: { inProtocol: boolean }) => b.inProtocol).length, exp.realBookmarks + exp.ownCastBookmarks + 1);
  assert.equal(m.sources['client:bookmarks'].pages, 3);
  const dc = m.directCasts!;
  assert.equal(dc.length, exp.uniqueConversations);
  assert.deepEqual(dc.find((d) => d.conversationId === '11-2001')?.categories, ['default', 'archived']);
  assert.deepEqual([dc[0].pages, dc[0].messages], [3, 120]);
  assert.equal(dc.find((d) => d.conversationId === '11-2003')?.status, 'empty');
  assert.match(dc.find((d) => d.conversationId === 'g/abc+def==?x')!.dir, /^raw\/client\/dm-messages\/\d{4}-g_abc_def___x$/);
  assert.equal(m.datasets.D10.count, exp.messages);

  // CSV round-trips the awkward text.
  const rows = parseCsv(fs.readFileSync(path.join(result.dir, 'csv/bookmarks.csv'), 'utf8'));
  assert.equal(rows.length - 1, bm.length);
  assert.ok(rows.some((row) => row[5] === exp.csvTrickyText));
  assert.ok(rows.slice(1).every((row) => row.length === rows[0].length));

  // Spot-check tooling: find reaches bookmarks and the oldest message of a long conversation.
  assert.ok(findInExport(result.dir, exp.oldestLongMessage).some((h) => h.dataset === 'dm-messages'));
  assert.ok(findInExport(result.dir, 'Grüße').some((h) => h.dataset === 'bookmarks'));

  // OS metadata written mid-run is not in SHA256SUMS, and verify ignores it.
  const sums = fs.readFileSync(path.join(result.dir, 'SHA256SUMS'), 'utf8');
  assert.ok(fs.existsSync(dsStore));
  assert.doesNotMatch(sums, /\.DS_Store/);

  const v = await verifyExport(result.dir, { env: { FC_SESSION_TOKEN: token } });
  const vd = verdicts(v.checks);
  for (const id of ['AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-10', 'AC-11', 'AC-12', 'AC-13', 'AC-14', 'AC-15', 'AC-16', 'AC-17', 'AC-18', 'AC-19', 'AC-20', 'AC-21']) assert.equal(vd[id], 'PASS', `${id}: ${v.checks.find((c) => c.id === id)?.detail.join(' | ')}`);
  assert.equal(vd['AC-22'], 'N/A');
  assert.equal(v.exitCode, 0);
  assert.deepEqual(v.checks.filter((c) => c.manual).map((c) => c.id), ['AC-12', 'AC-18']);
  assert.match(v.checks.find((c) => c.id === 'AC-16')!.detail.join('\n'), /0 with the token/);
  // The broken bookmark image counts as an image that was not stored (AC-19 stays honest).
  const ac19 = v.checks.find((c) => c.id === 'AC-19')!.detail.join('\n');
  assert.match(ac19, new RegExp(`image URLs ${exp.imageUrls}; stored by hash ${exp.imageUrls - exp.brokenImageUrls} `));

  const ic = spawnSync(process.execPath, [path.join(repo, 'scripts/import-check.mjs'), result.dir], { encoding: 'utf8' });
  assert.equal(ic.status, 0, ic.stdout + ic.stderr);
  assert.match(ic.stdout, /bookmarks {2}raw pages 231 · with hash and cast text 231 · normalized 231 \(same\) · csv 231 \(same\) · AGREE/);
});

test('bookmark lookup: a signed cast only the lookup can find is stored, marked inProtocol and checked by AC-04', async () => {
  const r = await mockPrivateExport();
  const { result, mock } = r;
  assert.equal(result.exitCode, 0, r.logs.join('\n'));
  // Every other protocol-found bookmark was already fetched (own or context cast) and is reused. The
  // fid 999 cast is not in the recording, so only the bookmark lookup can find it.
  const exp = mock.data.expect;
  const reused = exp.realBookmarks + exp.ownCastBookmarks;
  const lookupHash = toHex(r.lookupOnly.hash);
  assert.match(result.manifest.sources['protocol:bookmarked-casts'].notes![0], new RegExp(`signed casts found ${reused + 1} \\(already fetched ${reused}, looked up \\d+\\); not found`));

  const pb = path.join(result.dir, 'raw/protocol/bookmarked-casts.pb');
  const stored = decodeDelimited(fs.readFileSync(pb)).map((b) => Message.decode(b));
  assert.equal(stored.length, reused + 1);
  assert.ok(stored.some((x) => toHex(x.hash) === lookupHash && x.data?.fid === 999), 'lookup-only cast missing from bookmarked-casts.pb');

  const bm = JSON.parse(fs.readFileSync(path.join(result.dir, 'normalized/bookmarks.json'), 'utf8')).records;
  const rec = bm.find((b: { hash?: string }) => b.hash === lookupHash);
  assert.deepEqual([rec?.position, rec?.fid, rec?.inProtocol, rec?.protocolHash, rec?.embedsSource], [bm.length, 999, true, lookupHash, 'protocol']);

  const ac04 = (await verifyExport(result.dir)).checks.find((c) => c.id === 'AC-04')!;
  assert.equal(ac04.verdict, 'PASS', ac04.detail.join('\n'));
  assert.match(ac04.detail.join('\n'), new RegExp(`bookmarked-casts ${reused + 1}/${reused + 1}(,|$)`, 'm'));

  // AC-04 checks this cast itself: one flipped bit in its signature fails AC-04, naming its hash.
  const bytes = fs.readFileSync(pb);
  const sig = Buffer.from(r.lookupOnly.signature);
  const at = bytes.indexOf(sig);
  assert.ok(at >= 0 && bytes.indexOf(sig, at + 1) === -1, 'signature not found exactly once');
  bytes[at] ^= 1;
  fs.writeFileSync(pb, bytes);
  const tampered = (await verifyExport(result.dir)).checks.find((c) => c.id === 'AC-04')!;
  assert.equal(tampered.verdict, 'FAIL');
  assert.ok(tampered.detail.includes(`bookmarked-casts ${lookupHash} hashOk=true sigOk=false`), tampered.detail.join('\n'));
});

test('a server echoing the token in error bodies: saved redacted, and the endpoints count as unavailable', async () => {
  const r = await mockPrivateExport({ mock: { echoToken: true, rejectPaths: { '/v2/draft-casts': 403, '/v2/get-muted-channels': 403 } } });
  const { result, token } = r;
  assert.equal(result.exitCode, 0, r.logs.join('\n'));
  assert.equal(result.manifest.sources['client:drafts'].status, 'unavailable:403');
  for (const rel of ['raw/client/drafts/error-0001.json', 'raw/client/muted-channels/error-0001.json']) {
    const body = fs.readFileSync(path.join(result.dir, rel), 'utf8');
    assert.match(body, /Unauthorized: received Bearer \[REDACTED\]/, rel);
  }
  assert.equal(scanTreeForSecret(result.dir, token).hits.length, 0);
  const v = await verifyExport(result.dir, { env: { FC_SESSION_TOKEN: token } });
  // SPEC AC-21 allows unavailable:<reason>; the report says which.
  assert.equal(verdicts(v.checks)['AC-21'], 'PASS');
  assert.match(v.checks.find((c) => c.id === 'AC-21')!.detail[0], /drafts: client:drafts status unavailable:403/);
});

test('a broken server: a looping cursor and an unreadable conversation fail the run and verify', async () => {
  const r = await mockPrivateExport({
    mock: {
      loopCursor: ['/v2/draft-casts'],
      data: (() => {
        const d = buildPrivateFixture();
        d.conversations.request.push({ ...d.conversations.request[0], conversationId: '11-missing' });
        return d;
      })(),
    },
  });
  const m = r.result.manifest;
  assert.equal(r.result.exitCode, 1);
  assert.equal(m.sources['client:drafts'].status, 'error:cursor-loop');
  assert.match(m.datasets.D10.status, /^error:client:dm-messages/);
  assert.equal(m.directCasts!.find((d) => d.conversationId === '11-missing')?.status, 'unavailable:400');
  const v = await verifyExport(r.result.dir);
  const vd = verdicts(v.checks);
  for (const id of ['AC-01', 'AC-18', 'AC-21']) assert.equal(vd[id], 'FAIL', id);
  const ac18 = v.checks.find((c) => c.id === 'AC-18')!.detail.join('\n');
  assert.match(ac18, /not exhausted: conversation #\d+/);
  assert.doesNotMatch(ac18, /11-missing/, 'verify output names a conversation id');
});

test('a run without --private sends no token and leaves the private criteria N/A', async () => {
  const t = sentinel();
  const r = await replayExport({ env: { FC_SESSION_TOKEN: t } });
  assert.equal(r.exitCode, 0);
  for (const s of r.seen) assert.equal(s.headers.authorization, undefined);
  for (const id of ['D3', 'D10', 'D11', 'D12', 'D13']) assert.equal(r.manifest.datasets[id].status, 'unavailable:private-not-requested');
  const v = await verifyExport(r.dir);
  const vd = verdicts(v.checks);
  for (const id of ['AC-12', 'AC-18', 'AC-21']) assert.equal(vd[id], 'N/A', id);
});

// ---------- the CLI ----------

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(repo, 'bin/castsnap.js'), ...args], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('CLI: auth-check and export --private against the mock, with the token only in the environment', async () => {
  const t = sentinel();
  const mock = await startMock({ token: t, echoToken: true });
  try {
    const base = `${mock.url}/~api`;
    const ok = await run(['auth-check', '--fid', '11', '--base', base], { FC_SESSION_TOKEN: `Bearer ${t}` });
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /auth-check: OK\. Token accepted by .*; it belongs to fid 11 .*which matches --fid 11\./);

    const other = await run(['auth-check', '--fid', '12', '--base', base], { FC_SESSION_TOKEN: t });
    assert.equal(other.code, 1);
    assert.match(other.out, /belongs to fid 11, not --fid 12\. Nothing was written\./);

    const wrong = sentinel();
    const rejected = await run(['auth-check', '--fid', '11', '--base', base], { FC_SESSION_TOKEN: wrong });
    assert.equal(rejected.code, 1);
    assert.match(rejected.out, /Token check failed: \/v2\/me returned HTTP 401/);

    const out = tmpDir('castsnap-cli-');
    const abort = await run(['export', '--fid', '12', '--private', '--base', base, '--out', out], { FC_SESSION_TOKEN: t });
    assert.equal(abort.code, 1, abort.out);
    assert.match(abort.out, /not --fid 12\. Nothing was written\./);
    assert.deepEqual(exportDirs(out), []);

    const evil = await run(['auth-check', '--fid', '11', '--base', 'https://evil.example'], { FC_SESSION_TOKEN: t });
    assert.equal(evil.code, 64);
    const spaced = await run(['auth-check', '--fid', '11', '--base', base], { FC_SESSION_TOKEN: `${t} ${t}` });
    assert.equal(spaced.code, 1);
    assert.match(spaced.out, /^Error: Session token not usable: the token contains spaces/m);

    for (const r of [ok, other, rejected, abort, evil, spaced]) assert.ok(!r.out.includes(t) && !r.out.includes(wrong), 'token printed');
    // Only /v2/me was ever asked for, and only on the mock.
    assert.ok(mock.requests.every((q) => q.path === '/v2/me'));
  } finally {
    await mock.close();
  }
});

// ---------- a network that fails mid-response, and a lane that stops ----------

test('a client body that fails mid-read is retried: the run completes with nothing lost', async () => {
  const r = await mockPrivateExport({ mock: { dropBody: { '/v2/direct-cast-conversation-messages': 1 } } });
  const m = r.result.manifest;
  assert.equal(r.result.exitCode, 0, r.logs.join('\n'));
  assert.equal(m.datasets.D10.status, 'complete');
  assert.ok(r.logs.some((l) => l.startsWith('    network error, retry 1 in 2s: ')), 'retry logged');
  assert.equal(m.laneErrors, undefined);
});

test('client sources that keep failing are errors: D1, D2, D6 and D8 never look complete, and the private data is kept', async () => {
  const dropBody = Object.fromEntries(['/v2/following', '/v2/followers', '/fc/blocked-users', '/v2/user-by-fid'].map((p) => [p, Infinity]));
  const r = await mockPrivateExport({ mock: { dropBody } });
  const m = r.result.manifest;
  assert.equal(r.result.exitCode, 1);
  for (const [id, source] of [['D1', 'following'], ['D2', 'followers'], ['D6', 'profile-before'], ['D8', 'blocked-users']]) {
    assert.equal(m.datasets[id].status, `error:client:${source}`, id);
    assert.match(m.sources[`client:${source}`].status, /^error:network:/, source);
  }
  assert.equal(m.datasets.D3.status, 'complete');
  for (const id of ['D3', 'D10', 'D11', 'D12', 'D13']) assert.notEqual(m.datasets[id].status, 'unavailable:private-not-requested', id);
  assert.ok(fs.existsSync(path.join(r.result.dir, 'normalized/bookmarks.json')));
  assert.ok(fs.existsSync(path.join(r.result.dir, 'csv/bookmarks.csv')));
  assert.equal(m.laneErrors, undefined, 'a failing source must not stop the lane');
});

test('a client lane that stops after the DM lists: the datasets it never reached are error:client-lane-aborted', async () => {
  const logs: string[] = [];
  let thrown = false;
  // An error outside any one source (here, from the log sink) stops the whole lane.
  const log = (s: string) => {
    logs.push(s);
    if (!thrown && s.includes('client:dm-conversations-void')) {
      thrown = true;
      throw new Error('log sink failed');
    }
  };
  const r = await mockPrivateExport({ export: { log } });
  const m = r.result.manifest;
  assert.equal(r.result.exitCode, 1);
  for (const id of ['D1', 'D2', 'D6', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13']) assert.equal(m.datasets[id].status, 'error:client-lane-aborted', id);
  assert.match(m.datasets.D10.notes.join('\n'), /not fetched, the client lane stopped first: client:dm-messages/);
  // Bookmarks were fetched before the lane stopped: they are kept and written out.
  assert.equal(m.datasets.D3.status, 'complete');
  assert.ok(fs.existsSync(path.join(r.result.dir, 'normalized/bookmarks.json')));
  assert.ok(fs.existsSync(path.join(r.result.dir, 'csv/bookmarks.csv')));
  assert.deepEqual(m.laneErrors, ['client lane failed (last source started: dm-conversations-void): log sink failed']);
  const lane = logs.find((l) => l.startsWith('Lane errors: '));
  assert.ok(lane?.startsWith('Lane errors: client lane failed (last source started: dm-conversations-void): log sink failed. Not fetched: client:following,'), lane);
  assert.match(lane!, /client:dm-messages/);
  assert.ok(logs.includes('Result: errors (exit 1). Re-run the export; see docs/USAGE.md.'));
  const v = await verifyExport(r.result.dir, { env: { FC_SESSION_TOKEN: r.token } });
  const ac01 = v.checks.find((c) => c.id === 'AC-01')!;
  assert.equal(ac01.verdict, 'FAIL');
  assert.ok(ac01.detail.includes('lane errors: client lane failed (last source started: dm-conversations-void): log sink failed'));
});

test('laneAbortStatus: a source missing because its lane stopped makes the dataset error:<lane>-lane-aborted', () => {
  const has = (s: string) => s === 'protocol:links';
  assert.deepEqual(laneAbortStatus(['protocol:links', 'client:following'], has, new Set(['client'])), { status: 'error:client-lane-aborted', lane: 'client', missing: ['client:following'] });
  assert.equal(laneAbortStatus(['protocol:links', 'client:following'], has, new Set()), null, 'no lane failed');
  assert.equal(laneAbortStatus(['protocol:links', 'client:following'], has, new Set(['protocol'])), null, 'the missing source is in another lane');
  assert.equal(laneAbortStatus(['protocol:casts'], () => false, new Set(['protocol']))?.status, 'error:protocol-lane-aborted');
});

test('an outage during the DM messages: after the first conversation uses up its retries, the rest try once each', async () => {
  const dmPath = '/v2/direct-cast-conversation-messages';
  const r = await mockPrivateExport({ mock: { dropBody: { [dmPath]: Infinity } } });
  const m = r.result.manifest;
  const dm = r.mock.requests.filter((q) => q.path === dmPath);
  const n = new Set(dm.map((q) => q.query.conversationId)).size;
  assert.ok(n > 1, `conversations requested: ${n}`);
  // The first conversation: 10 attempts on the primary host, then 1 on the fallback host. Each later one: 1 + 1.
  assert.equal(dm.length, 2 * n + 9);
  assert.equal(r.logs.filter((l) => l.includes('network still failing after 10 attempts')).length, 1);
  assert.ok(r.logs.includes('    network back: requests get full retries again'), 'the drafts request got through');
  assert.match(m.datasets.D10.status, /^error:/);
  assert.equal(m.sources['client:drafts'].status, 'complete');
  assert.equal(r.result.exitCode, 1);
});

test('the repo contains no sentinel after the private runs', () => {
  const skip = new Set(['node_modules', '.git']);
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (skip.has(e.name) ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : e.isFile() && /castsnap-sentinel-[0-9a-f]{8}-/.test(fs.readFileSync(path.join(d, e.name), 'utf8')) ? [path.join(d, e.name)] : []));
  assert.deepEqual(walk(repo), []);
});
