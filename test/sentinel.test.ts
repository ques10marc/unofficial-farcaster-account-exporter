// AC-16 with a sentinel fake token. A run without --private uses no token, so these tests pin down that a
// token present in the environment (as quick-capture uses it) is never sent, never written, and redacted
// from errors; and that if a server ever echoed it into a saved response, the export fails loudly (exit 2).
// The sentinel is random per run, so it never exists in the repo.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { TransportError } from '../src/protocol/types.ts';
import { scanTreeForSecret } from '../src/secrets.ts';
import { verifyExport } from '../src/verify.ts';
import { fixture, replayExport } from './helpers.ts';
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
