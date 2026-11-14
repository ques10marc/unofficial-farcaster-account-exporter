// Every cut of text that may hold the token redacts first, then cuts (release commit 2b). For each cut of
// N characters and each form of the fake token (length V), the form is placed at every offset p that
// straddles the cut (N-V+1 to N-1), plus the controls p = N-V and p = N, and the site's output must equal
// what it gives for the same input with that form already replaced by [REDACTED]. Exact equality catches
// a fragment of any length, even one character. Offsets count from the first character of the text that
// is cut, so for a value shown as JSON the opening quote is character 0.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ClientApi } from '../src/client.ts';
import { HttpTransport } from '../src/protocol/http.ts';
import { redactRegistered, redactThenCut, registerSecret } from '../src/secrets.ts';
import { shapeNote, statusFromMe, statusLine } from '../src/status.ts';
import { RateLimiter } from '../src/util.ts';
import { tmpDir } from './helpers.ts';
import { startMock } from './mock-server.ts';
import { buildPrivateFixture } from './private-fixtures.ts';
import type { ClientStore } from './replay.ts';

// A fake token, never a real one: 19 ASCII letters and digits and one "/", so its four forms all differ.
const FAKE = 'Qz7mK2pX9vB4nR8tW5y/';
const FORMS = [FAKE, encodeURIComponent(FAKE), Buffer.from(FAKE).toString('base64'), Buffer.from(FAKE).toString('hex')];
const FILL = '#';
const REST = FILL.repeat(30);
const BASE = 'http://127.0.0.1:1';
// The fixed text each site puts around the text it cuts.
const FIXED = ['[REDACTED]', 'errors[0].message: ', '{"errors":[{"message":"', '"}]}', `${BASE} storageLimitsByFid: HTTP 400 `, 'Account status: optInStatus=', ' (from me)', '"', 'result: ', '(number); pages 1'];
const repo = path.join(import.meta.dirname, '..');

const counts = new Map<string, { straddles: number; controls: number }>();
// The offsets of the middle straddles through getObject's non-JSON return, outside the counts above.
const nonJson: number[] = [];

// Runs one site over every form and offset. build(p, piece) gives the site's output for an input whose
// cut text holds piece (a form, or [REDACTED]) at offset p.
async function straddle(site: string, n: number, build: (p: number, piece: string) => string | Promise<string>): Promise<void> {
  const c = { straddles: 0, controls: 0 };
  for (const [i, form] of FORMS.entries()) {
    for (let p = n - form.length; p <= n; p++) {
      const got = await build(p, form);
      const want = await build(p, '[REDACTED]');
      assert.equal(got, want, `${site}: form ${i} (${form.length} characters) at offset ${p} of a ${n}-character cut`);
      if (p === n - form.length || p === n) c.controls++;
      else c.straddles++;
    }
  }
  counts.set(site, c);
}

const noLimit = () => new RateLimiter({ windows: [] });
const client = (status: number, body: string) => new ClientApi({ bases: [BASE], explicitBase: true, token: FAKE, fetchImpl: (async () => new Response(body, { status })) as typeof fetch, limiter: noLimit(), privateLimiter: noLimit(), wait: async () => {} });
const text = (p: number, piece: string) => FILL.repeat(p) + piece + REST;
// A value whose JSON text holds piece at offset p: the opening quote is character 0.
const value = (p: number, piece: string) => FILL.repeat(p - 1) + piece + REST;

test('the fake token: 20 characters, four forms that differ, hold no filler and share no 4-character run with fixed text', () => {
  assert.match(FAKE, /^[A-Za-z0-9]*\/[A-Za-z0-9]*$/);
  assert.deepEqual(FORMS.map((f) => f.length), [20, 22, 28, 40]);
  assert.ok(FORMS[2].endsWith('='));
  assert.equal(new Set(FORMS).size, 4);
  for (const a of FORMS) for (const b of FORMS) if (a !== b) assert.ok(!a.includes(b), 'one form holds another');
  for (const f of FORMS) {
    assert.ok(!f.includes(FILL));
    for (const x of FIXED) for (let i = 0; i + 4 <= x.length; i++) assert.ok(!f.includes(x.slice(i, i + 4)), `a form shares ${JSON.stringify(x.slice(i, i + 4))}`);
  }
});

test('a ClientApi redacts its own token even when it was never registered', async () => {
  assert.equal(redactRegistered(FAKE), FAKE, 'the fake token must not be registered yet');
  const r = await client(403, `denied: ${FAKE} was not accepted`).paginate('/v2/x', {}, 'items', 50, { auth: true });
  assert.equal(r.errorBody, 'denied: [REDACTED] was not accepted');
});

test('the client cuts: firstError (200), paginate and pagesRaw (2,000) and getObject (4,000), with a never-registered token', async () => {
  assert.equal(redactRegistered(FAKE), FAKE, 'the fake token must not be registered yet');
  await straddle('client.ts firstError', 200, async (p, piece) => (await client(403, JSON.stringify({ errors: [{ message: text(p, piece) }] })).pagesRaw('/v2/x', {}, { maxPages: 1 })).note ?? '');
  await straddle('client.ts paginate', 2000, async (p, piece) => (await client(403, text(p, piece)).paginate('/v2/x', {}, 'items', 50, { auth: true })).errorBody ?? '');
  await straddle('client.ts pagesRaw refused', 2000, async (p, piece) => (await client(403, text(p, piece)).pagesRaw('/v2/x', {}, { maxPages: 1 })).errorBody ?? '');
  await straddle('client.ts pagesRaw no result', 2000, async (p, piece) => (await client(200, text(p, piece)).pagesRaw('/v2/x', {}, { maxPages: 1 })).errorBody ?? '');
  await straddle('client.ts getObject', 4000, async (p, piece) => (await client(403, text(p, piece)).getObject('/v2/x', {}, { auth: true })).errorBody ?? '');
  // getObject's non-JSON return makes its own cut: one middle straddle per form, through a 200 answer.
  for (const form of FORMS) {
    const p = 4000 - Math.floor(form.length / 2);
    const got = await client(200, text(p, form)).getObject('/v2/x', {}, { auth: true });
    const want = await client(200, text(p, '[REDACTED]')).getObject('/v2/x', {}, { auth: true });
    assert.equal(got.status, 'error:non-json', `getObject non-JSON: the status for a ${form.length}-character form at offset ${p}`);
    assert.equal(got.errorBody, want.errorBody, `getObject non-JSON: a ${form.length}-character form at offset ${p} of a 4000-character cut`);
    nonJson.push(p);
  }
});

test('the helper, the hub error (200), the status value (120) and the shape note key (40), with the token registered', async () => {
  registerSecret(FAKE);
  assert.equal(redactRegistered(FAKE), '[REDACTED]');
  await straddle('secrets.ts redactThenCut', 64, (p, piece) => redactThenCut(text(p, piece), 64));
  await straddle('protocol/http.ts hub error', 200, async (p, piece) => {
    const t = new HttpTransport(BASE, (async () => new Response(text(p, piece), { status: 400 })) as typeof fetch);
    return t.storageLimits(1).then(
      () => 'no error',
      (e: Error) => e.message,
    );
  });
  await straddle('status.ts show', 120, (p, piece) => statusLine({ optInStatus: value(p, piece) }, 'me'));
  await straddle('status.ts shapeNote', 40, (p, piece) => shapeNote([{ result: { [text(p, piece)]: 1 } }]));
});

test('the cut tests count their own cases: 106 straddles and 8 controls at each of 9 sites', () => {
  assert.deepEqual(FORMS.map((f) => f.length), [20, 22, 28, 40]);
  assert.equal(counts.size, 9);
  for (const [site, c] of counts) assert.deepEqual(c, { straddles: 106, controls: 8 }, site);
  const total = [...counts.values()].reduce((a, c) => ({ straddles: a.straddles + c.straddles, controls: a.controls + c.controls }), { straddles: 0, controls: 0 });
  assert.deepEqual(total, { straddles: 954, controls: 72 });
  assert.deepEqual(nonJson, [3990, 3989, 3986, 3980], 'getObject non-JSON: one middle straddle per form');
});

// As in test/account-status.test.ts, timers fire at once, so the request gap costs nothing. The script runs
// against the local mock only, in a child process, so the mock can answer while the test waits.
const FAST_TIMERS = 'const st = globalThis.setTimeout; globalThis.setTimeout = (f, ms, ...a) => st(f, 0, ...a);';
function quickCapture(base: string, out: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; last: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(FAST_TIMERS)}`, 'scripts/quick-capture.mjs', '--base', base, '--out', out], { cwd: repo, env: { PATH: process.env.PATH ?? '', HOME: out, FC_SESSION_TOKEN: FAKE }, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => {
      stdout += d;
    });
    const timer = setTimeout(() => p.kill(), 60_000);
    p.on('error', reject);
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, last: stdout.trimEnd().split('\n').at(-1) ?? '' });
    });
  });
}

test('quick capture: the status value (120) redacts before its cut, one middle straddle per form', async (t) => {
  const n = 120;
  const me = (v: string) => ({ result: { user: { fid: 3, username: 'cutcheck', viewerContext: { optInStatus: v } }, enabledFeatureFlags: [] } });
  const lines = await Promise.all(
    FORMS.map(async (form) => {
      const p = n - Math.floor(form.length / 2);
      const fixture = buildPrivateFixture();
      const mock = await startMock({ token: FAKE, data: { ...fixture, me: me(value(p, form)) as typeof fixture.me }, publicStore: {} as ClientStore });
      const out = tmpDir('castsnap-cuts-');
      try {
        const run = await quickCapture(mock.url, out);
        const how = `exit code ${run.code}, signal ${run.signal}, last stdout line ${JSON.stringify(run.last)}`;
        const name = fs.readdirSync(out).find((f) => f.startsWith('quick-'));
        assert.ok(name, `quick capture wrote no folder (${how})`);
        const manifest = JSON.parse(fs.readFileSync(path.join(out, name, 'manifest.json'), 'utf8'));
        return { got: manifest.accountStatus?.line, want: statusLine(statusFromMe(me(value(p, '[REDACTED]'))), 'me'), p, length: form.length, ...run, how, filesWithToken: manifest.tokenSelfScan?.filesWithToken };
      } finally {
        await mock.close();
        fs.rmSync(out, { recursive: true, force: true });
      }
    }),
  );
  for (const l of lines) {
    const at = `quick capture: a ${l.length}-character form at offset ${l.p}`;
    t.diagnostic(`${at}: ${l.how}`);
    // The script saves /v2/me as received, form included, so its own token self-scan finds it: exit 2.
    assert.equal(l.code, 2, `${at}: ${l.how}`);
    assert.ok(l.filesWithToken > 0, `${at}: tokenSelfScan.filesWithToken is ${l.filesWithToken}`);
    assert.match(l.last, /^Token self-scan: [1-9]\d* file\(s\) contain the token -- DELETE THIS FOLDER and report it\.$/, `${at}: ${l.how}`);
    assert.equal(l.got, l.want, at);
  }
  assert.equal(lines.length, 4);
});
