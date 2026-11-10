// Owner-only permissions: the Windows path (icacls, whoami, the PowerShell read-back) with Windows faked
// through the injected runner, the shared SDDL rules, and the macOS/Linux mode read-back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { test } from 'node:test';
import { ClientApi } from '../src/client.ts';
import { checkLocation, DRIVE_SCRIPT, type Location, MOUNT_EXE } from '../src/location.ts';
import { ACL_SCRIPT, checkOwnerOnly, childEnv, currentUserSid, makeOwnerOnly, osDeps, parseAclJson, PrivacyError, type RunCmd } from '../src/permissions.ts';
import { verifyExport } from '../src/verify.ts';
import { FAKE_ENV, FAKE_SID, fakeWindows, ok, ownerOnlySddl } from './fake-windows.ts';
import { replayExport, tmpDir } from './helpers.ts';
import { mockPrivateExport } from './private-run.ts';

const LOCAL: Location = { kind: 'local', level: 'ok', label: 'a local folder' };
const exportDirs = (out: string) => (fs.existsSync(out) ? fs.readdirSync(out).filter((f) => f.startsWith('fc-export-')) : []);
const icaclsFails = () => ({ status: 5, stdout: '', stderr: 'Access is denied.' });
// A fake token under 16 characters (the scan ignores secrets under 8).
const FAKE_TOKEN = 'fkQ7zxW2pL';
const ENC = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false';
const check = (sddl: string) => checkOwnerOnly([{ rel: '', sddl }]);

// ---------- icacls and the read-back ----------

test('win32: icacls gets exactly /inheritance:r /grant:r *<user SID>:(OI)(CI)F, with no SYSTEM entry', () => {
  const f = fakeWindows();
  const root = tmpDir('castsnap-acl-');
  assert.deepEqual(makeOwnerOnly(root, osDeps(f.os)), { method: 'windows-acl', ok: true });
  const icacls = f.calls.filter((c) => c.exe === 'icacls.exe');
  assert.equal(icacls.length, 1);
  assert.deepEqual(icacls[0].args, [root, '/inheritance:r', '/grant:r', `*${FAKE_SID}:(OI)(CI)F`]);
  assert.ok(!icacls[0].args.some((a) => /SY|S-1-5-18/.test(a)), 'no SYSTEM entry');
});

test('win32 --private: the export folder is still empty when icacls runs', async () => {
  const f = fakeWindows();
  const r = await mockPrivateExport({ export: { os: f.os, location: LOCAL } });
  assert.deepEqual(f.icaclsSawEmpty, [true]);
  assert.ok(exportDirs(r.out).length === 1);
});

test('win32 --private: icacls failing stops with "Nothing was written", leaves no export folder, and sends no request beyond /v2/me', async () => {
  const f = fakeWindows({ icacls: icaclsFails });
  const out = tmpDir('castsnap-acl-fail-');
  const paths: string[] = [];
  const spy = (async (input: string | URL | Request, init?: RequestInit) => {
    paths.push(new URL(input instanceof Request ? input.url : input.toString()).pathname);
    return fetch(input, init);
  }) as typeof fetch;
  await assert.rejects(
    mockPrivateExport({ out, makeClient: (o) => new ClientApi({ ...o, fetchImpl: spy }), export: { os: f.os, location: LOCAL } }),
    (e: Error) => e instanceof PrivacyError && /could not be made readable by your account only \(icacls failed \(exit status 5\)\)\. Nothing was written\./.test(e.message),
  );
  assert.deepEqual(exportDirs(out), []);
  assert.ok(paths.length > 0, 'the /v2/me check ran');
  assert.ok(paths.every((p) => p.endsWith('/v2/me')), `requests: ${paths.join(', ')}`);
});

test('win32 public run: icacls failing warns and the export continues', async () => {
  const f = fakeWindows({ icacls: icaclsFails });
  const r = await replayExport({ os: f.os, location: LOCAL });
  assert.ok(r.logs.some((l) => l === 'castsnap: warning: the export folder could not be made readable by your account only (icacls failed (exit status 5)).'), r.logs.join('\n'));
  assert.ok(r.logs.some((l) => l.startsWith('Privacy: NOT limited to your account (windows-acl)')));
});

test('win32: icacls exits 0 but the read-back shows an inherited BUILTIN\\Users entry → refused, with no security ID in the reason', () => {
  const f = fakeWindows({ sddl: () => `${ownerOnlySddl()}(A;OICIID;FA;;;BU)` });
  const r = makeOwnerOnly(tmpDir('castsnap-acl-'), osDeps(f.os));
  assert.equal(r.ok, false);
  assert.match(r.problem ?? '', /^the permissions read back are not owner-only: access for other accounts$/);
  assert.doesNotMatch(r.problem ?? '', /S-1-/);
});

// ---------- whoami ----------

test('win32: the security ID comes from the SID column, also for non-ASCII and German account names', () => {
  for (const name of ['PC\\Jörg', 'PC\\Jürgen Müller-Weiß', 'PC\\Grüße, ""Ä"" & Söhne']) {
    const f = fakeWindows({ whoami: () => ok(`"${name}","S-1-5-21-7-8-9-1001"\r\n`) });
    assert.equal(currentUserSid(osDeps(f.os)), 'S-1-5-21-7-8-9-1001', name);
  }
});

test('win32 --private: a work or school (Entra ID, S-1-12-1-…) account stops the run, saying so plainly and with no security ID', async () => {
  const f = fakeWindows({ whoami: () => ok('"AzureAD\\Jörg","S-1-12-1-111-222-333-444"\r\n') });
  const out = tmpDir('castsnap-entra-');
  await assert.rejects(
    mockPrivateExport({ out, export: { os: f.os, location: LOCAL } }),
    (e: Error) => e instanceof PrivacyError && /work or school account/.test(e.message) && /not supported for --private yet/.test(e.message) && !/S-1-/.test(e.message) && /Nothing was written/.test(e.message),
  );
  assert.deepEqual(exportDirs(out), []);
});

// ---------- child commands ----------

test('win32: child commands never see the token, in their environment or their arguments', async () => {
  const env = { ...FAKE_ENV, PATH: 'C:\\Windows\\System32', FC_SESSION_TOKEN: FAKE_TOKEN, TEMP: 'C:\\Temp' };
  const exported = (await replayExport({ location: LOCAL })).dir as string;
  const f = fakeWindows();
  const root = tmpDir('castsnap-acl-');
  makeOwnerOnly(root, osDeps({ ...f.os, env })); // whoami, icacls, the read-back
  checkLocation(root, osDeps({ ...f.os, env })); // the drive facts (location.ts)
  await verifyExport(exported, { os: { ...f.os, env }, env }); // AC-16's read
  checkLocation(os.tmpdir(), osDeps({ platform: 'darwin', run: f.run, env })); // /sbin/mount
  const seen = f.calls.map((c) => (c.exe !== 'powershell.exe' ? c.exe : c.args.at(-1) === DRIVE_SCRIPT ? 'drive facts' : `permissions, recurse ${c.env.CASTSNAP_RECURSE}`));
  assert.deepEqual(seen, ['whoami.exe', 'icacls.exe', 'permissions, recurse 0', 'drive facts', 'permissions, recurse 1', 'mount']);
  for (const c of f.calls) {
    assert.ok(!Object.values(c.env).some((v) => v.includes(FAKE_TOKEN)), `${c.exe} env`);
    assert.ok(!c.args.some((a) => a.includes(FAKE_TOKEN)), `${c.exe} args`);
  }
});

test('win32: the child environment holds exactly SystemRoot, windir, SystemDrive, TEMP, TMP, USERPROFILE, LOCALAPPDATA and the call\'s extras', () => {
  const allowed = ['LOCALAPPDATA', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'windir'];
  const env = { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', SystemDrive: 'C:', TEMP: 'C:\\T', TMP: 'C:\\T', USERPROFILE: 'C:\\Users\\Jörg', LOCALAPPDATA: 'C:\\Users\\Jörg\\AppData\\Local', PATH: 'C:\\x', Path: 'C:\\y', PSModulePath: 'C:\\m', FC_SESSION_TOKEN: FAKE_TOKEN };
  assert.deepEqual(Object.keys(childEnv(env, { CASTSNAP_ROOT: 'C:\\out', fc_session_token: FAKE_TOKEN })).sort(), [...allowed, 'CASTSNAP_ROOT'].sort());
  // Each only when set.
  assert.deepEqual(Object.keys(childEnv({ SystemRoot: 'C:\\Windows', PATH: 'C:\\x' })), ['SystemRoot']);
  // And the commands castsnap runs get no more than that.
  const f = fakeWindows();
  makeOwnerOnly(tmpDir('castsnap-acl-'), osDeps({ ...f.os, env }));
  for (const c of f.calls) for (const k of Object.keys(c.env)) assert.ok([...allowed, 'CASTSNAP_ROOT', 'CASTSNAP_RECURSE'].includes(k), `${c.exe}: ${k}`);
});

test('win32: whoami, icacls and PowerShell run by absolute paths under SystemRoot; no usable SystemRoot fails closed', () => {
  const f = fakeWindows();
  makeOwnerOnly(tmpDir('castsnap-acl-'), osDeps(f.os));
  assert.deepEqual(
    f.calls.map((c) => c.file),
    ['C:\\Windows\\System32\\whoami.exe', 'C:\\Windows\\System32\\icacls.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
  );
  for (const env of [{}, { SystemRoot: 'Windows' }, { SystemRoot: '\\Windows' }]) {
    const g = fakeWindows();
    const r = makeOwnerOnly(tmpDir('castsnap-acl-'), osDeps({ ...g.os, env }));
    assert.equal(r.ok, false);
    assert.match(r.problem ?? '', /SystemRoot is not set to an absolute path/);
    assert.equal(g.calls.length, 0, 'no command ran by a bare name');
  }
});

test('the PowerShell scripts contain no double quote', () => {
  for (const s of [ACL_SCRIPT, DRIVE_SCRIPT]) assert.ok(!s.includes('"'), s);
});

test('every PowerShell script sets UTF-8 output without a byte-order mark before it prints', () => {
  for (const s of [ACL_SCRIPT, DRIVE_SCRIPT]) {
    assert.ok(s.split('\n').includes(ENC), s);
    assert.ok(s.indexOf(ENC) < s.indexOf('ConvertTo-Json'), s);
  }
});

test('the permission-list parser accepts output that starts with a byte-order mark', () => {
  const list = [{ rel: '', sddl: ownerOnlySddl() }];
  assert.deepEqual(parseAclJson(`\uFEFF${JSON.stringify(list)}`), list);
});

// ---------- the shared SDDL rules ----------

test('SDDL rules: an inherited BUILTIN\\Users allow entry fails', () => {
  const c = check(`${ownerOnlySddl()}(A;OICIID;FA;;;BU)`);
  assert.equal(c.ok, false);
  assert.deepEqual(c.problems, ['access for other accounts']);
});

test('SDDL rules: a deny entry for Everyone passes', () => {
  assert.deepEqual(check(`O:${FAKE_SID}G:${FAKE_SID}D:PAI(D;OICI;FA;;;WD)(A;OICI;FA;;;${FAKE_SID})`).problems, []);
});

test('SDDL rules: a null permission list, or none at all, fails', () => {
  for (const sddl of [`O:${FAKE_SID}G:${FAKE_SID}D:NO_ACCESS_CONTROL`, `O:${FAKE_SID}G:${FAKE_SID}`]) {
    const c = check(sddl);
    assert.equal(c.ok, false, sddl);
    assert.ok(c.problems.includes('no permission list, or an empty (null) one that allows everyone'), sddl);
  }
});

test('SDDL rules: an export folder without P (inheritance not removed) fails', () => {
  const c = check(`O:${FAKE_SID}G:${FAKE_SID}D:AI(A;OICI;FA;;;${FAKE_SID})`);
  assert.equal(c.inheritanceRemoved, false);
  assert.deepEqual(c.problems, ['inheritance not removed']);
});

test('SDDL rules: a SYSTEM (SY) allow entry fails', () => {
  const c = check(`${ownerOnlySddl()}(A;OICI;FA;;;SY)`);
  assert.equal(c.ok, false);
  assert.deepEqual(c.problems, ['access for other accounts']);
});

// ---------- macOS and Linux ----------

test('macOS/Linux --private: a mode read back as 0755 stops the run', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const out = tmpDir('castsnap-mode-');
    await assert.rejects(
      mockPrivateExport({ out, export: { os: { platform, modeOf: () => 0o40755 }, location: LOCAL } }),
      (e: Error) => e instanceof PrivacyError && /\(the folder is open to other accounts\)\. Nothing was written\./.test(e.message),
    );
    assert.deepEqual(exportDirs(out), [], platform);
  }
});

test('macOS: /sbin/mount is run by its absolute path with no arguments', () => {
  const calls: { file: string; args: string[] }[] = [];
  const run: RunCmd = (file, args) => {
    calls.push({ file, args });
    return ok('/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n');
  };
  checkLocation(os.tmpdir(), osDeps({ platform: 'darwin', run }));
  assert.equal(MOUNT_EXE, '/sbin/mount');
  assert.deepEqual(calls, [{ file: '/sbin/mount', args: [] }]);
});
