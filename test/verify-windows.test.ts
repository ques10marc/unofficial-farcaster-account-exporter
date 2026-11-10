// AC-16 on Windows, checked on the Mac through the fake Windows runner (test/fake-windows.ts).
// macOS and Linux stay covered by export-replay.test.ts and sentinel.test.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { verifyExport } from '../src/verify.ts';
import { FAKE_SID, type FakeWindowsOptions, fakeWindows, OTHER_SID, ok, ownerOnlySddl } from './fake-windows.ts';
import { replayExport, tmpDir } from './helpers.ts';

const exported = replayExport().then((r) => r.dir as string);

async function ac16(dir: string, o: FakeWindowsOptions, env: NodeJS.ProcessEnv = {}) {
  const { checks } = await verifyExport(dir, { os: fakeWindows(o).os, env });
  const c = checks.find((x) => x.id === 'AC-16');
  assert.ok(c, 'AC-16 present');
  return { verdict: c.verdict, text: c.detail.join('\n') };
}
const entryOf = (dir: string, dirs: boolean) => {
  const e = fs.readdirSync(dir, { withFileTypes: true }).find((x) => x.isDirectory() === dirs);
  assert.ok(e, dirs ? 'the export has a sub-folder' : 'the export has a file');
  return e.name;
};

test('win32 AC-16: owner-only permissions PASS, even though a file is 0644 on the Mac', async () => {
  const dir = await exported;
  fs.chmodSync(path.join(dir, entryOf(dir, false)), 0o644);
  const r = await ac16(dir, {});
  assert.equal(r.verdict, 'PASS', r.text);
  assert.match(r.text, /^Windows permissions \(security IDs\): inheritance removed: yes; items giving access to other accounts: 0 of \d+$/m);
});

test('win32 AC-16: one sub-folder giving access to another account FAILs, "1 of N", with no security IDs printed', async () => {
  const dir = await exported;
  const sub = entryOf(dir, true);
  const r = await ac16(dir, { sddl: (rel) => (rel === sub ? `O:${FAKE_SID}G:${FAKE_SID}D:AI(A;OICI;FA;;;${FAKE_SID})(A;OICIID;FA;;;${OTHER_SID})` : ownerOnlySddl()) });
  assert.equal(r.verdict, 'FAIL', r.text);
  assert.match(r.text, /items giving access to other accounts: 1 of \d+/);
  assert.doesNotMatch(r.text, /S-1-5-21/);
});

test('win32 AC-16: a file owned by another account, with owner-only allow entries, FAILs, "1 of N"', async () => {
  const dir = await exported;
  const file = entryOf(dir, false);
  const r = await ac16(dir, { sddl: (rel) => (rel === file ? ownerOnlySddl(FAKE_SID, OTHER_SID) : ownerOnlySddl()) });
  assert.equal(r.verdict, 'FAIL', r.text);
  assert.match(r.text, /items giving access to other accounts: 1 of \d+/);
  assert.doesNotMatch(r.text, /S-1-5-21/);
});

test('win32 AC-16: PowerShell failing FAILs with the reason', async () => {
  const r = await ac16(await exported, { acl: () => ({ status: 1, stdout: '', stderr: '' }) });
  assert.equal(r.verdict, 'FAIL', r.text);
  assert.match(r.text, /could not be read: PowerShell failed \(exit status 1\)/);
});

test('win32 AC-16: a cut-off read (ENOBUFS, no status) FAILs even though its partial output parses', async () => {
  const partial = JSON.stringify([{ rel: '', sddl: ownerOnlySddl() }]);
  const r = await ac16(await exported, { acl: () => ({ ...ok(partial), status: null, error: Object.assign(new Error('cut off'), { code: 'ENOBUFS' }) }) });
  assert.equal(r.verdict, 'FAIL', r.text);
  assert.match(r.text, /could not be read: PowerShell did not run \(ENOBUFS\)/);
});

test('win32 AC-16: owner-only permissions with a planted fake token still FAIL (the token scan stays on win32)', async () => {
  const dir = tmpDir('castsnap-win-planted-');
  fs.cpSync(await exported, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'planted.txt'), 'x fkQ7zxW2pL y');
  const r = await ac16(dir, {}, { FC_SESSION_TOKEN: 'fkQ7zxW2pL' });
  assert.match(r.text, /items giving access to other accounts: 0 of \d+/);
  assert.match(r.text, /files, 1 with the token/);
  assert.equal(r.verdict, 'FAIL', r.text);
});
