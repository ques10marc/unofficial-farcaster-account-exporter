// The account status line and the own-record datasets, D19 (the own moderation record) and D20 (the
// stayed list): castsnap's line for each optInStatus value and for nerfed, every answer to the two
// requests in a --private export against the mock, a public run, auth-check, and quick capture with a
// fake fetch. No request leaves the machine.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { countEntries, pickStatus, recordCounts, shapeNote, stayedCount, statusFromMe, statusFromProfile, statusLine } from '../src/status.ts';
import { verifyExport } from '../src/verify.ts';
import { replayExport, tmpDir } from './helpers.ts';
import { type MockOptions, startMock } from './mock-server.ts';
import { buildPrivateFixture } from './private-fixtures.ts';
import { mockPrivateExport } from './private-run.ts';

const repo = path.join(import.meta.dirname, '..');
const sentinel = () => `castsnap-sentinel-${randomUUID()}`;
const RAP = '/v2/network-code/public-rap-sheet';
const STAYED = '/v2/opt-in/following-stayed';
const SPAM = '2 (unlikely to engage in spammy behavior)';
const AUTH_REQUIRED = { errors: [{ message: 'Authentication required' }] };
type Answer = { status?: number; body: unknown };
const profile = (viewerContext: Record<string, unknown>, extras: Record<string, unknown> = { publicSpamLabel: SPAM }) => ({ result: { user: { fid: 11, username: 'mock', viewerContext }, extras } });
const me = (optInStatus: string, viewerContext: Record<string, unknown> = { optInStatus }) => ({ result: { user: { fid: 11, username: 'mock', neynarScore: 0.5, viewerContext }, optInStatus, enabledFeatureFlags: ['a'] } });
// Three pages: 2 posts and 1 account charge, then 1 post, then 1 post.
const RAP_PAGES: Answer[] = [
  { body: { result: { posts: [{ kind: 'rapSheet' }, { kind: 'rapSheet' }], accountCharges: [{ kind: 'accountCharges' }] } } },
  { body: { result: { posts: [{ kind: 'rapSheet' }] } } },
  { body: { result: { posts: [{ kind: 'rapSheet' }] } } },
];
const STAYED_12: Answer = { body: { result: { count: 12, users: [1, 2, 3, 4].map((fid) => ({ fid, displayName: `S${fid}`, pfp: { url: `https://img.example/${fid}.png` } })) } } };
// FID 11's recorded profile, which the mock and the replay serve: pending, with this spam label.
const PENDING_LINE = `Account status: optInStatus=pending publicSpamLabel="${SPAM}" (from profile-after)`;

test('status line: pending, opted_in, moderated_out and nerfed, as castsnap prints it', () => {
  for (const v of ['pending', 'opted_in', 'moderated_out']) {
    assert.equal(statusLine(statusFromProfile(profile({ optInStatus: v })), 'profile-after'), `Account status: optInStatus=${v} publicSpamLabel="${SPAM}" (from profile-after)`);
    assert.equal(statusLine(statusFromMe(me(v)), '/v2/me'), `Account status: optInStatus=${v} (from /v2/me)`);
  }
  assert.equal(statusLine(statusFromProfile(profile({ optInStatus: 'pending', nerfed: true })), 'profile-after'), `Account status: optInStatus=pending publicSpamLabel="${SPAM}" nerfed=true (from profile-after)`);
  assert.equal(statusLine(statusFromMe(me('pending', { optInStatus: 'pending', nerfed: true })), '/v2/me'), 'Account status: optInStatus=pending nerfed=true (from /v2/me)');
  // /v2/me's own optInStatus wins over its viewerContext copy, and the signed-in fields are kept.
  assert.deepEqual(statusFromMe(me('moderated_out', { optInStatus: 'pending' })), { optInStatus: 'moderated_out', neynarScore: 0.5, enabledFeatureFlags: ['a'] });
});

test('status line and counts: fields the app leaves out, odd values, shapes castsnap cannot count, and an unreadable answer', () => {
  assert.equal(statusLine(statusFromProfile(profile({}, {})), 'profile-after'), 'Account status: optInStatus=(not reported) publicSpamLabel=(not reported) (from profile-after)');
  assert.equal(statusLine(statusFromProfile(profile({ optInStatus: 'a b\nc', nerfed: false })), 'profile-before'), `Account status: optInStatus="a b\\nc" publicSpamLabel="${SPAM}" nerfed=false (from profile-before)`);
  const long = statusLine(statusFromProfile(profile({ optInStatus: 'x'.repeat(500) })), 'profile-after');
  assert.ok(long.length < 250, long);
  for (const body of [undefined, null, 'text', { result: {} }, { result: { user: 'x' } }]) assert.equal(statusFromProfile(body), null);
  assert.equal(statusLine(null, 'profile-after'), 'Account status: not available (no readable answer from profile-after)');
  assert.equal(pickStatus({ before: profile({ optInStatus: 'pending' }), me: me('opted_in') }).from, 'profile-before');
  assert.deepEqual(pickStatus({ me: me('opted_in') }), { fields: { optInStatus: 'opted_in', neynarScore: 0.5, enabledFeatureFlags: ['a'] }, from: 'me' });
  // Lists directly under result are counted; a result with fields but no list is not, so it can never
  // pass for empty.
  assert.equal(countEntries(RAP_PAGES.map((p) => p.body)), 5);
  assert.equal(countEntries([{ result: { posts: [], accountCharges: [] } }, { result: {} }]), 0);
  assert.equal(countEntries([{ result: [1, 2] }]), 2);
  assert.equal(countEntries([{ result: { rapSheet: { posts: [{}] } } }]), null);
  assert.equal(stayedCount([STAYED_12.body]), 12);
  assert.equal(stayedCount([{ result: { users: [{}, {}] } }]), 2);
  assert.equal(stayedCount([{ result: { hasStayed: false } }]), null);
  assert.equal(shapeNote([STAYED_12.body]), 'result: count(number), users[4]; pages 1');
});

interface OwnRun {
  label: string;
  mock: Partial<MockOptions>;
  D19: [status: string | RegExp, count: number | null, files: string[]];
  D20: [status: string | RegExp, count: number | null, files: string[]];
  notes?: Record<string, string>;
  cursors?: boolean[];
  verify: RegExp;
}

test('own record: every answer is a dataset status, saved as it came, and the export still exits 0', async () => {
  const runs: OwnRun[] = [
    { label: 'a paginated sheet and the stayed list', mock: { ownRecord: RAP_PAGES, stayed: STAYED_12 }, D19: ['complete', 5, ['page-0001.json', 'page-0002.json', 'page-0003.json']], D20: ['complete', 12, ['page-0001.json']], notes: { 'client:following-stayed': 'result: count(number), users[4]; pages 1' }, cursors: [false, true, true], verify: /^own moderation record D19: complete, count 5; stayed list D20: complete, count 12$/ },
    { label: 'empty answers', mock: { ownRecord: [{ body: { result: { posts: [], accountCharges: [] } } }], stayed: { body: { result: { count: 0, users: [] } } } }, D19: ['empty', 0, ['page-0001.json']], D20: ['empty', 0, ['page-0001.json']], verify: /^own moderation record D19: empty, count 0; stayed list D20: empty, count 0$/ },
    { label: '401 with an Authentication required body, and 403', mock: { ownRecord: [{ status: 401, body: AUTH_REQUIRED }], stayed: { status: 403, body: { errors: [{ message: 'Forbidden' }] } } }, D19: ['unavailable:401', null, ['error-0001.json']], D20: ['unavailable:403', null, ['error-0001.json']], notes: { 'client:moderation-record': 'errors[0].message: Authentication required' }, verify: /^own moderation record D19: unavailable:401; stayed list D20: unavailable:403$/ },
    { label: 'a network failure, and an Authentication required body sent with HTTP 200', mock: { ownRecord: RAP_PAGES, dropBody: { [RAP]: Infinity }, stayed: { body: AUTH_REQUIRED } }, D19: [/^error:network:/, null, []], D20: ['unavailable:no-result', null, ['error-0001.json']], notes: { 'client:following-stayed': 'errors[0].message: Authentication required' }, verify: /^own moderation record D19: error:network:.*; stayed list D20: unavailable:no-result$/ },
    { label: 'a shape castsnap cannot count, and an app without the stayed list', mock: { ownRecord: [{ body: { result: { rapSheet: { posts: [{}] } } } }] }, D19: ['complete', null, ['page-0001.json']], D20: ['unavailable:404', null, ['error-0001.json']], notes: { 'client:moderation-record': 'entries not counted' }, verify: /^own moderation record D19: complete; stayed list D20: unavailable:404$/ },
  ];
  for (const run of runs) {
    const { result, token, mock, logs } = await mockPrivateExport({ mock: run.mock });
    const m = result.manifest;
    const at = `${run.label}\n${logs.join('\n')}`;
    assert.equal(result.exitCode, 0, at);
    assert.equal(m.result, 'ok', at);
    for (const [id, source] of [['D19', 'client:moderation-record'], ['D20', 'client:following-stayed']] as const) {
      const [status, count, files] = run[id];
      const d = m.datasets[id];
      if (typeof status === 'string') assert.equal(d.status, status, `${run.label}: ${id}`);
      else assert.match(d.status, status, `${run.label}: ${id}`);
      assert.equal(d.count, count, `${run.label}: ${id} count`);
      assert.deepEqual(m.sources[source].files.map((f) => path.basename(f)), files, `${run.label}: ${id} files`);
      for (const f of m.sources[source].files) assert.ok(!fs.readFileSync(path.join(result.dir, f), 'utf8').includes(token), `${f} holds the token`);
    }
    for (const [source, text] of Object.entries(run.notes ?? {})) assert.ok(m.sources[source].notes?.some((n) => n.includes(text)), `${run.label}: ${source} notes ${JSON.stringify(m.sources[source].notes)}`);
    // The token's own FID and the app's page size; the token on these requests.
    const own = mock.requests.filter((q) => q.path === RAP || q.path === STAYED);
    assert.ok(own.length >= 2, run.label);
    for (const q of own) assert.equal(q.auth, 'valid', `${run.label}: ${q.prefix}${q.path}`);
    const sheet = own.filter((q) => q.path === RAP);
    for (const q of sheet) assert.deepEqual([q.query.fid, q.query.limit], ['11', '20'], run.label);
    if (run.cursors) assert.deepEqual(sheet.map((q) => q.query.cursor !== undefined), run.cursors, run.label);
    assert.ok(logs.includes(PENDING_LINE), at);
    assert.ok(!logs.join('\n').includes(token), 'token in the log');
    const v = await verifyExport(result.dir, { env: { FC_SESSION_TOKEN: token } });
    const check = (id: string) => v.checks.find((c) => c.id === id)!;
    for (const id of ['AC-01', 'AC-02']) assert.equal(check(id).verdict, 'PASS', `${run.label}: ${id}: ${check(id).detail.join(' | ')}`);
    assert.equal(check('STATUS').verdict, 'INFO', run.label);
    assert.equal(check('STATUS').detail[0], PENDING_LINE, run.label);
    assert.match(check('STATUS').detail[1] ?? '', run.verify, run.label);
    assert.equal(v.exitCode, 0, run.label);
  }
});

test('own record: a public run sends no own-record request, records D19 and D20 as not requested, and prints the status line', async () => {
  const r = await replayExport();
  assert.equal(r.exitCode, 0, r.logs.join('\n'));
  for (const id of ['D19', 'D20']) assert.equal(r.manifest.datasets[id].status, 'unavailable:private-not-requested');
  assert.ok(!r.seen.some((s) => s.url.includes('/v2/network-code/') || s.url.includes('/v2/opt-in/')));
  assert.ok(r.logs.includes(PENDING_LINE), r.logs.join('\n'));
  const fields = { optInStatus: 'pending', canSendDirectCasts: false, publicSpamLabel: SPAM };
  assert.deepEqual(r.manifest.accountStatus, { line: PENDING_LINE, source: 'client:profile-after', fields: { 'client:profile-before': fields, 'client:profile-after': fields } });
  const v = await verifyExport(r.dir);
  const st = v.checks.find((c) => c.id === 'STATUS')!;
  assert.deepEqual([st.verdict, st.detail[0], st.detail[1]], ['INFO', PENDING_LINE, 'own moderation record D19: unavailable:private-not-requested; stayed list D20: unavailable:private-not-requested']);
});

// blockedByCount, mutedByCount and total on verify's STATUS line, from the own moderation record's
// saved first page, on --private exports only. One mock --private export whose record has the fields
// the app sent for a pending account (values made up); each test edits its own copy.
const COUNTED = { result: { blockedByCount: 3, mutedByCount: 5, total: 0, posts: [], accountCharges: [] } };
const RECORD_PAGE = 'raw/client/moderation-record/page-0001.json';
const BEFORE = 'own moderation record D19: empty, count 0; stayed list D20: complete, count 12';
let counted: Promise<string> | undefined;
async function countedCopy(): Promise<string> {
  counted ??= mockPrivateExport({ mock: { ownRecord: [{ body: COUNTED }], stayed: STAYED_12 } }).then((r) => r.result.dir);
  const dir = path.join(tmpDir('castsnap-counts-'), 'export');
  fs.cpSync(await counted, dir, { recursive: true });
  return dir;
}
const recordLine = async (dir: string) => (await verifyExport(dir)).checks.find((c) => c.id === 'STATUS')?.detail[1];

test('own record counts: verify shows blockedByCount, mutedByCount and total on a --private export', async () => {
  assert.equal(await recordLine(await countedCopy()), 'own moderation record D19: empty, count 0 (blockedByCount 3, mutedByCount 5, total 0); stayed list D20: complete, count 12');
  assert.equal(recordCounts({ result: { total: 7, blockedByCount: 1.5, mutedByCount: -1 } }), 'blockedByCount 1.5, mutedByCount -1, total 7');
});

test('own record counts: a page without them, an unreadable page or a missing page leaves the line as before', async () => {
  const dir = await countedCopy();
  for (const text of [JSON.stringify({ result: { posts: [], accountCharges: [] } }), JSON.stringify({ result: [] }), JSON.stringify(AUTH_REQUIRED), '{not json']) {
    fs.writeFileSync(path.join(dir, RECORD_PAGE), text);
    assert.equal(await recordLine(dir), BEFORE, text);
  }
  fs.rmSync(path.join(dir, RECORD_PAGE));
  assert.equal(await recordLine(dir), BEFORE);
});

test('own record counts: an odd value shows only its type, never its text', async () => {
  const dir = await countedCopy();
  fs.writeFileSync(path.join(dir, RECORD_PAGE), JSON.stringify({ result: { blockedByCount: '3 private words', mutedByCount: null, total: { n: 1 } } }));
  const line = await recordLine(dir);
  assert.equal(line, 'own moderation record D19: empty, count 0 (blockedByCount (string), mutedByCount (null), total (object)); stayed list D20: complete, count 12');
  assert.ok(!line?.includes('private words'), line);
  assert.equal(recordCounts({ result: { mutedByCount: 3, total: [1, 2] } }), 'mutedByCount 3, total [2]');
});

test('own record counts: an export without D19 shows the line as before', async () => {
  const dir = await countedCopy();
  const file = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  // As in an export made before D19 and D20 existed; the record's page stays in the folder.
  for (const id of ['D19', 'D20']) delete m.datasets[id];
  for (const s of ['client:moderation-record', 'client:following-stayed']) delete m.sources[s];
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
  assert.equal(await recordLine(dir), 'own moderation record D19: not in this export; stayed list D20: not in this export');
});

test('own record counts: a public export shows the line as before, even with a record page in its folder', async () => {
  const r = await replayExport();
  fs.mkdirSync(path.join(r.dir, 'raw/client/moderation-record'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, RECORD_PAGE), JSON.stringify(COUNTED));
  assert.equal(await recordLine(r.dir), 'own moderation record D19: unavailable:private-not-requested; stayed list D20: unavailable:private-not-requested');
});

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(repo, 'bin/castsnap.js'), ...args], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('auth-check prints the account status from /v2/me, with nerfed when the app reports it, and asks for nothing else', async () => {
  const token = sentinel();
  const fixture = buildPrivateFixture();
  const cases: [string, Record<string, unknown>, string][] = [
    ['pending', { optInStatus: 'pending' }, 'Account status: optInStatus=pending (from /v2/me)'],
    ['opted_in', { optInStatus: 'opted_in' }, 'Account status: optInStatus=opted_in (from /v2/me)'],
    ['moderated_out', { optInStatus: 'moderated_out' }, 'Account status: optInStatus=moderated_out (from /v2/me)'],
    ['pending', { optInStatus: 'pending', nerfed: true }, 'Account status: optInStatus=pending nerfed=true (from /v2/me)'],
  ];
  for (const [optIn, viewerContext, line] of cases) {
    const mock = await startMock({ token, data: { ...fixture, me: me(optIn, viewerContext) } });
    try {
      const r = await runCli(['auth-check', '--fid', '11', '--base', `${mock.url}/~api`], { FC_SESSION_TOKEN: token });
      assert.equal(r.code, 0, r.out);
      const lines = r.out.trimEnd().split('\n');
      assert.match(lines.at(-2) ?? '', /^auth-check: OK\. Token accepted by /);
      assert.equal(lines.at(-1), line);
      assert.ok(!r.out.includes(token), 'token printed');
      assert.ok(mock.requests.every((q) => q.path === '/v2/me'));
    } finally {
      await mock.close();
    }
  }
});

// A fake fetch for quick capture: answers by path from QC_ANSWERS (page by cursor, with next.cursor added
// to every 200 page but the last), an empty list for every other path, and a log line per request (path,
// query, and whether it carried a token) in QC_LOG. Timers fire at once, so the request gap costs
// nothing. Nothing leaves the machine.
const QC_PRELOAD = `
const fs = process.getBuiltinModule('node:fs');
const st = globalThis.setTimeout;
globalThis.setTimeout = (f, ms, ...a) => st(f, 0, ...a);
const answers = JSON.parse(process.env.QC_ANSWERS);
globalThis.fetch = async (u, init) => {
  const url = new URL(String(u));
  fs.appendFileSync(process.env.QC_LOG, url.pathname + url.search + ' ' + (init?.headers?.authorization ? 'token' : 'none') + '\\n');
  const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const list = answers[url.pathname];
  if (!list) return reply(200, { result: { users: [], bookmarks: [], conversations: [], drafts: [], mutedUsers: [], frames: [], channels: [], blockedUsers: [] } });
  const i = Number(url.searchParams.get('cursor') ?? 0);
  const a = list[i];
  if (!a) return reply(404, { errors: [{ message: 'not found' }] });
  const status = a.status ?? 200;
  return reply(status, status === 200 && i + 1 < list.length ? { ...a.body, next: { cursor: String(i + 1) } } : a.body);
};
`;

function quickCapture(token: string, answers: Record<string, Answer[]>) {
  const out = tmpDir('castsnap-qc-');
  const log = path.join(out, 'requests.log');
  const p = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(QC_PRELOAD)}`, 'scripts/quick-capture.mjs', '--base', 'http://127.0.0.1:9', '--out', out], { cwd: repo, env: { PATH: process.env.PATH ?? '', HOME: out, FC_SESSION_TOKEN: token, QC_ANSWERS: JSON.stringify(answers), QC_LOG: log }, encoding: 'utf8', timeout: 60_000 });
  const name = fs.readdirSync(out).find((f) => f.startsWith('quick-'));
  assert.ok(name, p.stdout + p.stderr);
  const dir = path.join(out, name);
  return { p, dir, manifest: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')), requests: fs.readFileSync(log, 'utf8').trimEnd().split('\n') };
}

test('quick capture: the own record and the stayed list, every outcome, and the same status line as castsnap', () => {
  const token = sentinel();
  const cases: { profile: unknown; rap: Answer[]; stayed: Answer[]; expect: Record<string, [string, number, number]> }[] = [
    { profile: profile({ optInStatus: 'moderated_out', nerfed: true }), rap: RAP_PAGES, stayed: [STAYED_12], expect: { 'moderation-record': ['complete', 5, 3], 'following-stayed': ['complete', 12, 1] } },
    { profile: profile({ optInStatus: 'opted_in' }), rap: [{ status: 401, body: AUTH_REQUIRED }], stayed: [{ status: 403, body: { errors: [{ message: 'Forbidden' }] } }], expect: { 'moderation-record': ['unavailable:401', 0, 0], 'following-stayed': ['unavailable:403', 0, 0] } },
    { profile: profile({ optInStatus: 'pending' }), rap: [{ body: AUTH_REQUIRED }], stayed: [{ body: { result: { count: 0, users: [] } } }], expect: { 'moderation-record': ['unavailable:no-result', 0, 1], 'following-stayed': ['empty', 0, 1] } },
  ];
  for (const c of cases) {
    const { p, dir, manifest, requests } = quickCapture(token, { '/v2/me': [{ body: me('pending') }], '/v2/user-by-fid': [{ body: c.profile }], [RAP]: c.rap, [STAYED]: c.stayed });
    assert.equal(p.status, 0, p.stdout + p.stderr);
    const lines = p.stdout.trimEnd().split('\n');
    assert.equal(lines.at(-1), 'Token self-scan: 0 file(s) contain the token.');
    // The same line castsnap prints for the same answer.
    assert.ok(lines.includes(statusLine(statusFromProfile(c.profile), 'profile-after')), p.stdout);
    for (const [name, want] of Object.entries(c.expect)) {
      const e = manifest.endpoints[name];
      assert.deepEqual([e.status, e.items, e.pages], want, name);
    }
    // Only the token's own FID and the app's page size, with the token on both requests.
    const own = requests.filter((l) => l.startsWith(RAP) || l.startsWith(STAYED));
    assert.ok(own.length >= 2 && own.every((l) => l.endsWith(' token')), own.join('\n'));
    const sheet = own.filter((l) => l.startsWith(RAP));
    assert.ok(sheet.every((l) => l.startsWith(`${RAP}?fid=11&limit=20`)), own.join('\n'));
    if (c.rap === RAP_PAGES) assert.equal(sheet.length, 3, own.join('\n'));
    assert.ok(!fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').includes(token));
  }
});
