// AC-16 with a sentinel fake token. A run without --private uses no token, so these tests pin down that a
// token present in the environment (as quick-capture uses it) is never sent, never written, and redacted
// from errors; and that if a server ever echoed it into a saved response, the export fails loudly (exit 2).
// The sentinel is random per run, so it never exists in the repo.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ClientApi, type ClientOptions } from '../src/client.ts';
import { TransportError } from '../src/protocol/types.ts';
import { registerSecret, safeErrorText, scanTreeForSecret } from '../src/secrets.ts';
import { verifyExport } from '../src/verify.ts';
import { fixture, replayExport } from './helpers.ts';
import { mockPrivateExport } from './private-run.ts';
import { ReplayTransport } from './replay.ts';

const SENTINEL = `fcx-sentinel-${randomUUID()}`;
const env = { FC_SESSION_TOKEN: `Bearer ${SENTINEL}` };
const repo = path.join(import.meta.dirname, '..');

test('sentinel token in the environment is never sent and never written', async () => {
  const r = await replayExport({ env });
  assert.equal(r.exitCode, 0);
  assert.ok(r.seen.length > 0);
  for (const s of r.seen) {
    assert.ok(!s.url.includes(SENTINEL), 'token in URL');
    assert.ok(!JSON.stringify(s.headers).includes(SENTINEL), 'token in headers');
    assert.equal(s.headers.authorization, undefined);
  }
  assert.equal(scanTreeForSecret(r.dir, SENTINEL).hits.length, 0);
  assert.ok(!r.logs.join('\n').includes(SENTINEL));
  assert.deepEqual({ ran: r.manifest.tokenScan.ran, hits: r.manifest.tokenScan.filesWithToken }, { ran: true, hits: 0 });
  const v = await verifyExport(r.dir, { env });
  const ac16 = v.checks.find((c) => c.id === 'AC-16')!;
  assert.equal(ac16.verdict, 'PASS', ac16.detail.join(' | '));
  assert.match(ac16.detail.join('\n'), /with the token: 0|0 with the token/);
});

test('an error message that echoes the token is redacted in the manifest and logs', async () => {
  class Echo extends ReplayTransport {
    async castById(): Promise<never> {
      throw new TransportError(`upstream said: bad auth ${SENTINEL}`, { retryable: false, code: 'echo' });
    }
  }
  const r = await replayExport({ env, transport: new Echo(fixture('fid11-protocol.json')) });
  const manifest = fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8');
  assert.match(manifest, /upstream said: bad auth \[REDACTED\]/);
  assert.equal(scanTreeForSecret(r.dir, SENTINEL).hits.length, 0);
  assert.ok(!r.logs.join('\n').includes(SENTINEL));
});

test('a server echoing the token into a saved page makes the export exit 2', async () => {
  const store = fixture('fid11-client.json');
  const key = '/v1/user-following-channels?fid=11&limit=50';
  const body = JSON.parse(store[key].body);
  body.result.channels[0].description = `echo ${SENTINEL}`;
  store[key].body = JSON.stringify(body);
  const r = await replayExport({ env, clientStore: store });
  assert.equal(r.exitCode, 2);
  assert.match(r.logs.join('\n'), /DELETE THIS FOLDER/);
  const v = await verifyExport(r.dir, { env });
  assert.equal(v.checks.find((c) => c.id === 'AC-16')!.verdict, 'FAIL');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

// ---------- fcx and the quick-capture script, run as child processes ----------

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fcx-home-'));
// preload: module source that runs before the program. The sentinel is only ever in FC_SESSION_TOKEN.
function run(args: string[], o: { token?: boolean; preload?: string; timeout?: number } = {}): { code: number | null; out: string } {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home, ...(o.token ? { FC_SESSION_TOKEN: SENTINEL } : {}) };
  const pre = o.preload ? ['--import', `data:text/javascript,${encodeURIComponent(o.preload)}`] : [];
  const p = spawnSync(process.execPath, [...pre, ...args], { cwd: repo, env, encoding: 'utf8', timeout: o.timeout ?? 20_000 });
  return { code: p.status, out: p.stdout + p.stderr };
}
const FCX = ['bin/fcx.js', 'export', '--fid', '11'];
const QUICK = ['scripts/quick-capture.mjs', '--fid', '11'];

test('a token pasted as an argument or command is not echoed, but a mistyped flag is still named', () => {
  for (const args of [[...FCX, SENTINEL], [...QUICK, SENTINEL], ['bin/fcx.js', SENTINEL]]) {
    const r = run(args);
    assert.equal(r.code, 64, r.out);
    assert.ok(!r.out.includes(SENTINEL), `echoed by ${args.filter((a) => a !== SENTINEL).join(' ')}`);
    assert.match(r.out, /not shown in case it is your session token/);
  }
  assert.match(run([...FCX, '--fdi']).out, /unknown argument: --fdi/);
  assert.match(run([...QUICK, '--fdi']).out, /Unknown argument: --fdi/);
});

// Each preload replaces fetch, so the first request, made after the token is read, throws or rejects
// outside the program's promise chain.
const CRASHES = {
  thrown: 'globalThis.fetch = () => { setTimeout(() => { throw new Error(`thrown with ${process.env.FC_SESSION_TOKEN}`); }); return new Promise(() => {}); };',
  rejected: 'globalThis.fetch = () => { Promise.reject(new Error(`rejected with ${process.env.FC_SESSION_TOKEN}`)); return new Promise(() => {}); };',
};

test('an error thrown or rejected outside the main promise chain is printed redacted, with exit 1', { timeout: 60_000 }, () => {
  for (const [kind, preload] of Object.entries(CRASHES)) {
    for (const args of [['bin/fcx.js', 'auth-check', '--fid', '11', '--base', 'http://127.0.0.1:9'], ['scripts/quick-capture.mjs']]) {
      const r = run(args, { token: true, preload });
      assert.equal(r.code, 1, r.out);
      assert.ok(!r.out.includes(SENTINEL), `${kind}: printed by ${args[0]}`);
      assert.match(r.out, new RegExp(`Error: ${kind} with \\[REDACTED\\]`));
    }
  }
});

// ---------- new error paths: retries, failing sources, a stopped lane ----------
// Each puts the sentinel inside an error message. The in-memory manifest and the client's own log lines
// are checked as well as the files, so the redaction at the source is tested, not just the final pass
// over manifest.json.

// A client whose fetch makes the first `times` responses for one path fail mid-body, with the token in
// the error.
const failingBodyClient = (pathname: string, times: number) => (o: ClientOptions) => {
  let n = 0;
  const inner = o.fetchImpl ?? fetch;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : input.toString()).pathname.endsWith(pathname) && n++ < times) {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"result":'));
          c.error(new Error(`connection reset, peer said ${SENTINEL}`));
        },
      });
      return new Response(body, { status: 200 });
    }
    return inner(input, init);
  }) as typeof fetch;
  return new ClientApi({ ...o, fetchImpl });
};
const assertNoSentinel = (dir: string, ...logs: string[][]) => {
  assert.equal(scanTreeForSecret(dir, SENTINEL).hits.length, 0, 'token in a file');
  for (const l of logs) assert.ok(!l.join('\n').includes(SENTINEL), 'token in a log');
};

test('a client body that fails with the token in its error: the retry line is redacted, and the run completes', async () => {
  const r = await mockPrivateExport({ token: SENTINEL, makeClient: failingBodyClient('/v2/draft-casts', 1) });
  assert.equal(r.result.exitCode, 0, r.logs.join('\n'));
  assert.ok(r.logs.includes('    network error, retry 1 in 2s: connection reset, peer said [REDACTED]'), r.logs.join('\n'));
  assertNoSentinel(r.result.dir, r.logs);
});

test('a client source that keeps failing with the token in its error: its status is redacted', async () => {
  const r = await mockPrivateExport({ token: SENTINEL, makeClient: failingBodyClient('/v2/draft-casts', Infinity) });
  const m = r.result.manifest;
  assert.equal(r.result.exitCode, 1);
  assert.equal(m.sources['client:drafts'].status, 'error:network:connection reset, peer said [REDACTED]');
  assert.equal(m.datasets.D11.status, 'error:client:drafts');
  assert.match(fs.readFileSync(path.join(r.result.dir, 'manifest.json'), 'utf8'), /error:network:connection reset, peer said \[REDACTED\]/);
  assertNoSentinel(r.result.dir, r.logs);
});

class ThrowingClient extends ClientApi {
  async paginate(path: string, params: Record<string, string | number>, itemsKey: string, limit: number, o: { auth?: boolean } = {}) {
    if (path === '/v2/get-muted-users') throw new Error(`parser broke on ${SENTINEL}`);
    return super.paginate(path, params, itemsKey, limit, o);
  }
}

test('an exception in one client source, with the token in it: recorded redacted, and the lane goes on', async () => {
  const r = await mockPrivateExport({ token: SENTINEL, makeClient: (o) => new ThrowingClient(o) });
  const m = r.result.manifest;
  assert.equal(m.sources['client:muted-users'].status, 'error:exception:parser broke on [REDACTED]');
  assert.equal(m.datasets.D12.status, 'error:client:muted-users');
  assert.equal(m.sources['client:favorite-mini-apps'].status, 'complete', 'the next source still ran');
  assert.equal(m.laneErrors, undefined);
  assert.equal(r.result.exitCode, 1);
  assertNoSentinel(r.result.dir, r.logs);
});

test('a client lane that stops with the token in its error: laneErrors and the summary line are redacted', async () => {
  const logs: string[] = [];
  let thrown = false;
  // An error outside any one source (here, from the log sink) stops the whole lane.
  const log = (s: string) => {
    logs.push(s);
    if (!thrown && s.includes('client:dm-conversations-void')) {
      thrown = true;
      throw new Error(`log sink failed near ${SENTINEL}`);
    }
  };
  const r = await mockPrivateExport({ token: SENTINEL, export: { log } });
  assert.deepEqual(r.result.manifest.laneErrors, ['client lane failed (last source started: dm-conversations-void): log sink failed near [REDACTED]']);
  assert.ok(logs.some((l) => l.startsWith('Lane errors: client lane failed (last source started: dm-conversations-void): log sink failed near [REDACTED]. Not fetched: ')), logs.join('\n'));
  assertNoSentinel(r.result.dir, logs, r.logs);
});

test('safeErrorText redacts before it truncates, so a cut never leaves part of a token', () => {
  registerSecret(SENTINEL);
  assert.equal(safeErrorText(new Error('x'.repeat(5000))), `${'x'.repeat(300)}…`);
  // The sentinel straddles the 300-character cut.
  const straddle = safeErrorText(new Error(`${'x'.repeat(295)}${SENTINEL}`));
  assert.ok(!straddle.includes(SENTINEL.slice(0, 5)), straddle);
  assert.equal(straddle, `${'x'.repeat(295)}[REDA…`);
});

// Replaces fetch for quick capture: every endpoint answers with empty results, except that the first
// drafts request's body fails partway, with the token in the error.
const QUICK_BODY_FAILS = `
let failed = false;
globalThis.fetch = async (u) => {
  const url = new URL(String(u));
  if (url.pathname === '/v2/draft-casts' && !failed) {
    failed = true;
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"result":')); c.error(new Error('connection reset, peer said ' + process.env.FC_SESSION_TOKEN)); } });
    return new Response(body, { status: 200 });
  }
  const result = { user: { fid: 11, username: 'stub' }, bookmarks: [], conversations: [], messages: [], drafts: [], mutedUsers: [], frames: [], channels: [], blockedUsers: [], users: [] };
  return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
};`;

test('quick capture: a body that fails with the token in its error is retried, and the retry line is redacted', { timeout: 90_000 }, () => {
  // About 18 requests, paced 600 ms apart, plus one 2 s retry wait.
  const r = run(QUICK, { token: true, preload: QUICK_BODY_FAILS, timeout: 60_000 });
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes(SENTINEL), 'token printed');
  assert.match(r.out, /network error, retry 1 in 2s: connection reset, peer said \[REDACTED\]/);
  assert.match(r.out, /\bdrafts\s+empty\b/);
  assert.equal(scanTreeForSecret(home, SENTINEL).hits.length, 0);
});

test('the repo contains no sentinel after the runs', () => {
  const skip = new Set(['node_modules', '.git']);
  let hits = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.readFileSync(p).includes(SENTINEL)) hits++;
    }
  };
  walk(repo);
  assert.equal(hits, 0);
});
