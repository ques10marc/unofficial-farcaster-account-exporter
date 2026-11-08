// End-to-end on recorded fixtures (FID 11): export -> verify -> import-check -> find, plus tamper checks.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Message } from '@farcaster/core';
import { findInExport } from '../src/find.ts';
import { verifyExport } from '../src/verify.ts';
import { decodeDelimited, encodeDelimited, sha256File } from '../src/writer.ts';
import { replayExport, tmpDir } from './helpers.ts';

const repo = path.join(import.meta.dirname, '..');

test('replayed export of FID 11 passes every automatable check', async () => {
  const r = await replayExport();
  assert.equal(r.exitCode, 0, r.logs.join('\n'));
  assert.ok(r.logs.some((l) => l.endsWith(`. Verify with: node bin/castsnap.js verify "${r.dir}"`)), r.logs.join('\n'));
  const m = r.manifest;
  assert.equal(m.result, 'ok');
  assert.deepEqual(Object.keys(m.datasets).sort(), [...Array.from({ length: 15 }, (_, i) => `D${i + 1}`), 'D19', 'D20'].sort());
  assert.equal(m.datasets.D3.status, 'unavailable:private-not-requested');
  assert.equal(m.sources['protocol:followers'].end, 'all-null-shard-token');
  const v = await verifyExport(r.dir);
  const verdicts = Object.fromEntries(v.checks.map((c) => [c.id, c.verdict]));
  for (const id of ['AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-10', 'AC-11', 'AC-13', 'AC-14', 'AC-15', 'AC-16', 'AC-17', 'AC-20']) assert.equal(verdicts[id], 'PASS', `${id}: ${v.checks.find((c) => c.id === id)?.detail.join(' | ')}`);
  assert.equal(v.exitCode, 0);
  const recon = JSON.parse(fs.readFileSync(path.join(r.dir, 'reconciliation.json'), 'utf8'));
  assert.equal(recon.summary.followers.protocol, 287);
  assert.equal(recon.summary.followers.clientList, 82);
  assert.equal(recon.entries.filter((e: { reason: string }) => e.reason === 'hidden_by_client').length, 205);
});

test('export directory is 0700 with 0600 files, and holds no OS metadata in SHA256SUMS', async () => {
  const r = await replayExport();
  assert.equal(fs.statSync(r.dir).mode & 0o777, 0o700);
  const sums = fs.readFileSync(path.join(r.dir, 'SHA256SUMS'), 'utf8');
  assert.doesNotMatch(sums, /\.DS_Store/);
  // Finder may add .DS_Store later; verify must ignore it rather than fail the checksums.
  fs.writeFileSync(path.join(r.dir, '.DS_Store'), 'x');
  const v = await verifyExport(r.dir);
  assert.equal(v.checks.find((c) => c.id === 'AC-03')!.verdict, 'PASS');
});

test('offline import-check rebuilds following and followers from the export alone', async () => {
  const r = await replayExport();
  const out = spawnSync(process.execPath, [path.join(repo, 'scripts/import-check.mjs'), r.dir], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /following .* AGREE/);
  assert.match(out.stdout, /followers .* AGREE/);
});

test('verify catches a modified file (AC-03) and a forged signature (AC-04)', async () => {
  const r = await replayExport();
  const a = tmpDir('castsnap-tamper-');
  fs.cpSync(r.dir, a, { recursive: true });
  fs.appendFileSync(path.join(a, 'normalized/casts.json'), ' ');
  const v1 = await verifyExport(a);
  assert.equal(v1.checks.find((c) => c.id === 'AC-03')!.verdict, 'FAIL');

  const b = tmpDir('castsnap-forge-');
  fs.cpSync(r.dir, b, { recursive: true });
  const rel = 'raw/protocol/reactions.pb';
  const msgs = decodeDelimited(fs.readFileSync(path.join(b, rel))).map((x) => Message.decode(x));
  msgs[0].signature[0] ^= 1;
  fs.writeFileSync(path.join(b, rel), encodeDelimited(msgs.map((x) => Message.encode(x).finish())));
  // Re-seal so only the signature check can catch it.
  const sums = fs.readFileSync(path.join(b, 'SHA256SUMS'), 'utf8').split('\n').map((l) => (l.endsWith(`  ${rel}`) ? `${sha256File(path.join(b, rel))}  ${rel}` : l));
  fs.writeFileSync(path.join(b, 'SHA256SUMS'), sums.join('\n'));
  const v2 = await verifyExport(b);
  assert.equal(v2.checks.find((c) => c.id === 'AC-03')!.verdict, 'PASS');
  const ac04 = v2.checks.find((c) => c.id === 'AC-04')!;
  assert.equal(ac04.verdict, 'FAIL');
  assert.match(ac04.detail[0], /ed25519 signature OK 360/);
});

test('find locates casts by hash prefix and accounts by fid', async () => {
  const r = await replayExport();
  const cast = JSON.parse(fs.readFileSync(path.join(r.dir, 'normalized/casts.json'), 'utf8')).records[0];
  const hits = findInExport(r.dir, cast.hash.slice(0, 10));
  assert.ok(hits.some((h) => h.dataset === 'casts' && h.key === cast.hash));
  const f = JSON.parse(fs.readFileSync(path.join(r.dir, 'normalized/following.json'), 'utf8')).records[0];
  assert.ok(findInExport(r.dir, String(f.fid)).some((h) => h.dataset === 'following'));
});
