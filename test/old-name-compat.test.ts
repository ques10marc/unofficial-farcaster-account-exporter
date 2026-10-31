// Exports written before the rename to castsnap name the tool `fcx` in manifest.json and carry fcx.local
// schema $ids and titles. verify and import-check must grade them exactly as they grade a current export.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { verifyExport } from '../src/verify.ts';
import { sha256File, SUMS_FILE } from '../src/writer.ts';
import { replayExport, tmpDir } from './helpers.ts';

const repo = path.join(import.meta.dirname, '..');

const rewriteJson = (file: string, edit: (x: Record<string, unknown>) => void) => {
  const x = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(x);
  fs.writeFileSync(file, `${JSON.stringify(x, null, 2)}\n`);
};

test('an export written under the old name fcx verifies and import-checks like a current one', async () => {
  const r = await replayExport();
  assert.equal(r.exitCode, 0, r.logs.join('\n'));
  const old = tmpDir('castsnap-oldname-');
  fs.cpSync(r.dir, old, { recursive: true });

  rewriteJson(path.join(old, 'manifest.json'), (m) => {
    assert.equal(m.tool, 'castsnap');
    m.tool = 'fcx';
  });
  const schemaDir = path.join(old, 'normalized/schemas');
  const schemas = fs.readdirSync(schemaDir);
  assert.ok(schemas.includes('reconciliation.schema.json') && schemas.length > 1, schemas.join(', '));
  for (const f of schemas) {
    rewriteJson(path.join(schemaDir, f), (s) => {
      assert.match(String(s.$id), /^https:\/\/castsnap\.local\/schemas\/v1\//);
      assert.match(String(s.title), /^castsnap /);
      s.$id = String(s.$id).replace('https://castsnap.local/', 'https://fcx.local/');
      s.title = String(s.title).replace(/^castsnap /, 'fcx ');
    });
  }
  // Re-seal every listed file, as the old exporter sealed its own output.
  const sums = fs.readFileSync(path.join(old, SUMS_FILE), 'utf8').split('\n').map((l) => {
    if (!l) return l;
    const rel = l.slice(l.indexOf('  ') + 2);
    return `${sha256File(path.join(old, rel))}  ${rel}`;
  });
  fs.writeFileSync(path.join(old, SUMS_FILE), sums.join('\n'));

  const grade = async (dir: string) => {
    const v = await verifyExport(dir);
    return { exitCode: v.exitCode, checks: v.checks.map((c) => ({ id: c.id, verdict: c.verdict, detail: c.detail.map((d) => d.replaceAll(dir, 'DIR')) })) };
  };
  const current = await grade(r.dir);
  assert.equal(current.exitCode, 0);
  assert.deepEqual(await grade(old), current);

  const importCheck = (dir: string) => spawnSync(process.execPath, [path.join(repo, 'scripts/import-check.mjs'), dir], { encoding: 'utf8' });
  const a = importCheck(r.dir);
  const b = importCheck(old);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.match(b.stdout, /^Result: PASS$/m);
  assert.equal(b.stdout.replaceAll(old, 'DIR'), a.stdout.replaceAll(r.dir, 'DIR'));
});
