// Where the export goes: the location table (pure classifiers) and its integration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { ClientApi } from '../src/client.ts';
import { classifyLinux, classifyMac, classifyWindows, type DriveFacts, type Location, LocationRefused } from '../src/location.ts';
import { PrivacyError, type RunCmd } from '../src/permissions.ts';
import { verifyExport } from '../src/verify.ts';
import { fakeWindows, ownerOnlySddl } from './fake-windows.ts';
import { replayExport, tmpDir } from './helpers.ts';
import { mockPrivateExport } from './private-run.ts';

const repo = path.resolve(import.meta.dirname, '..');
const LOCAL: Location = { kind: 'local', level: 'ok', label: 'a local folder' };
const FIXED: DriveFacts = { type: 'Fixed', format: 'NTFS' };
const NET: DriveFacts = { type: 'Network', format: 'NTFS' };
const kindOf = (l: Location) => `${l.kind}/${l.level}`;
const icaclsFails = () => ({ status: 5, stdout: '', stderr: 'Access is denied.' });
const readManifest = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

// The real CLI, with stdin closed and only PATH and HOME in its environment.
function cli(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['bin/castsnap.js', ...args], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (out += b));
    p.stdin.end();
    const t = setTimeout(() => p.kill(), 20_000);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

const MAC_ROOT = '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)';

test('macOS: an smbfs share whose name contains " on ", mounted at a point with spaces, is refused', () => {
  const mounts = [MAC_ROOT, '//user@srv/Share on Mac on /Volumes/Share on Mac (smbfs, nodev, nosuid, mounted by user)'].join('\n');
  const l = classifyMac('/Volumes/Share on Mac/exports', '/Users/someone', mounts);
  assert.equal(l.level, 'refuse');
  assert.equal(l.kind, 'network');
  // Control: a path outside the share is still local.
  assert.equal(classifyMac('/Users/someone/exports', '/Users/someone', mounts).kind, 'local');
});

test('macOS: iCloud Drive and CloudStorage folders, an smbfs share whose name contains spaces, and msdos/exfat disks are refused', () => {
  const home = '/Users/someone';
  const mounts = [
    MAC_ROOT,
    '//user@srv/My Share on /Volumes/My Share (smbfs, nodev, nosuid, mounted by user)',
    '/dev/disk4s1 on /Volumes/USB STICK (msdos, local, nodev, nosuid, noowners)',
    '/dev/disk5s1 on /Volumes/Card (exfat, local, nodev, nosuid, noowners)',
  ].join('\n');
  const c = (p: string) => kindOf(classifyMac(p, home, mounts));
  assert.equal(c('/Users/someone/Library/CloudStorage/Dropbox/exports'), 'synced/refuse');
  assert.equal(c('/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/exports'), 'synced/refuse');
  assert.equal(c('/Volumes/My Share/exports'), 'network/refuse');
  assert.equal(c('/Volumes/USB STICK/exports'), 'no-permissions/refuse');
  assert.equal(c('/Volumes/Card/exports'), 'no-permissions/refuse');
  // Controls: an ordinary home folder and a folder beside the share are local.
  assert.equal(c('/Users/someone/exports'), 'local/ok');
  assert.equal(c('/Volumes/My Shared/exports'), 'local/ok');
});

test('Windows: UNC paths, \\\\?\\UNC\\… and \\\\wsl$\\… are refused as network paths', () => {
  for (const p of ['\\\\srv\\share\\x', '\\\\?\\UNC\\srv\\share\\x', '\\\\wsl$\\Ubuntu\\home\\x', '//srv/share/x']) {
    assert.deepEqual(classifyWindows(p, {}), { kind: 'network', level: 'refuse', label: 'a network path (a UNC or WSL path)' }, p);
  }
  // Controls: a long local path and an ordinary drive path are local.
  assert.equal(kindOf(classifyWindows('\\\\?\\C:\\Users\\x', {}, FIXED)), 'local/ok');
  assert.equal(kindOf(classifyWindows('C:\\Users\\x', {}, FIXED)), 'local/ok');
});

test('Windows: a mapped drive (DriveType Network) is refused', () => {
  assert.deepEqual(classifyWindows('Z:\\exports', {}, NET), { kind: 'network', level: 'refuse', label: 'a mapped network drive' });
  assert.equal(kindOf(classifyWindows('Z:\\exports', {}, FIXED)), 'local/ok');
});

test('Windows: FAT32 and exFAT drives are refused', () => {
  for (const format of ['FAT32', 'exFAT']) {
    assert.equal(kindOf(classifyWindows('E:\\exports', {}, { type: 'Removable', format })), 'no-permissions/refuse', format);
  }
  assert.equal(kindOf(classifyWindows('E:\\exports', {}, { type: 'Removable', format: 'NTFS' })), 'local/warn');
});

test('Windows: the three OneDrive folders are matched case-insensitively at a path boundary; OneDriveBackup is not matched', () => {
  const cases: [string, string, string][] = [
    ['OneDrive', 'C:\\Users\\Jörg\\OneDrive', 'c:\\USERS\\jörg\\onedrive\\exports'],
    ['OneDriveCommercial', 'C:\\Users\\Jörg\\OneDrive - Contoso', 'C:\\Users\\Jörg\\OneDrive - Contoso\\exports'],
    ['OneDriveConsumer', 'D:\\OneDrive', 'D:\\OneDrive'],
  ];
  for (const [k, v, p] of cases) assert.equal(kindOf(classifyWindows(p, { [k]: v }, FIXED)), 'synced/refuse', k);
  // A folder beside OneDrive whose name starts the same way, and a variable castsnap doesn't read.
  assert.equal(kindOf(classifyWindows('C:\\Users\\Jörg\\OneDriveBackup\\exports', { OneDrive: 'C:\\Users\\Jörg\\OneDrive' }, FIXED)), 'local/ok');
  assert.equal(kindOf(classifyWindows('C:\\B\\exports', { OneDriveBackup: 'C:\\B' }, FIXED)), 'local/ok');
});

test('Linux: network, shared and FAT file systems are refused; \\040 is unescaped; the longest mount point wins', () => {
  const types = ['nfs4', 'cifs', 'vfat', 'exfat', '9p', 'virtiofs', 'vboxsf', 'fuse.sshfs'];
  const info = [
    '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
    ...types.map((t, i) => `${30 + i} 22 0:${40 + i} / /mnt/${t} rw,relatime shared:${9 + i} - ${t} src rw`),
    '50 22 0:60 / /mnt/My\\040Share rw shared:20 - cifs //srv/s rw',
  ].join('\n');
  for (const t of types) assert.equal(classifyLinux(`/mnt/${t}/exports`, info).level, 'refuse', t);
  assert.equal(kindOf(classifyLinux('/mnt/My Share/exports', info)), 'network/refuse');
  // Control: a folder under / only is local.
  assert.equal(kindOf(classifyLinux('/home/someone/exports', info)), 'local/ok');
});

test('win32 --private: a refused location stops the run before the token is sent (no /v2/me request)', async () => {
  const paths: string[] = [];
  const spy = (async (input: string | URL | Request, init?: RequestInit) => {
    paths.push(new URL(input instanceof Request ? input.url : input.toString()).pathname);
    return fetch(input, init);
  }) as typeof fetch;
  const out = tmpDir('castsnap-loc-');
  await assert.rejects(
    mockPrivateExport({ out, makeClient: (o) => new ClientApi({ ...o, fetchImpl: spy }), export: { os: fakeWindows({ drive: NET }).os } }),
    (e: Error) => e instanceof LocationRefused && /--private stopped: the export folder would be on a mapped network drive/.test(e.message),
  );
  assert.deepEqual(paths, []);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('win32: a public run warns, --private refuses, and the override proceeds and is recorded in the manifest', async () => {
  const pub = await replayExport({ os: fakeWindows({ drive: NET }).os });
  assert.ok(pub.logs.includes('castsnap: warning: the export folder is on a mapped network drive; --private would refuse it. Other accounts, services or devices may be able to read what is written there.'), pub.logs.join('\n'));
  await assert.rejects(mockPrivateExport({ export: { os: fakeWindows({ drive: NET }).os } }), LocationRefused);
  const r = await mockPrivateExport({ export: { os: fakeWindows({ drive: NET }).os, allowUnsafeLocation: true } });
  assert.ok(r.logs.some((l) => l.includes('mapped network drive (allowed by --allow-unsafe-location)')), r.logs.join('\n'));
  assert.ok(r.logs.includes('Privacy: readable by your account only (windows-acl); location: a mapped network drive, allowed by --allow-unsafe-location'));
  const m = readManifest(r.result.dir);
  assert.equal(m.options.allowUnsafeLocation, true);
  assert.deepEqual(m.privacy.location, { kind: 'network', label: 'a mapped network drive' });
});

test('CLI: a refused --private location exits before any token question is written, and makes no request', async () => {
  const home = fs.realpathSync(tmpDir('castsnap-home-'));
  const cloud = path.join(home, 'Library', 'CloudStorage');
  fs.mkdirSync(cloud, { recursive: true });
  let connections = 0;
  const server = http.createServer((_q, s) => s.writeHead(500).end());
  server.on('connection', () => connections++);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const r = await cli(['export', '--private', '--fid', '11', '--out', path.join(cloud, 'exports'), '--base', base, '--media', 'none'], { PATH: process.env.PATH ?? '', HOME: home });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /--private stopped: the export folder would be on an iCloud Drive, Dropbox or other cloud storage folder/);
    assert.ok(!r.out.includes('Paste your session token'), r.out);
    assert.equal(connections, 0);
    assert.deepEqual(fs.readdirSync(cloud), []);
  } finally {
    server.close();
  }
});

test('CLI: export --allow-unsafe-location --fid 0 gives the --fid error (64), not "unknown argument"', async () => {
  const r = await cli(['export', '--allow-unsafe-location', '--fid', '0'], { PATH: process.env.PATH ?? '', HOME: tmpDir('castsnap-home-') });
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /--fid must be a positive integer/);
  assert.doesNotMatch(r.out, /unknown argument/);
});

test('win32: a failed drive-facts call gives "unknown", which refuses --private without the override and proceeds with it', async () => {
  await assert.rejects(
    mockPrivateExport({ export: { os: fakeWindows({ drive: null }).os } }),
    (e: Error) => e instanceof LocationRefused && /would be on a drive whose type could not be read/.test(e.message),
  );
  const r = await mockPrivateExport({ export: { os: fakeWindows({ drive: null }).os, allowUnsafeLocation: true } });
  assert.deepEqual(readManifest(r.result.dir).privacy.location, { kind: 'unknown', label: 'a drive whose type could not be read' });
});

test('win32 --private: the override never relaxes a failed icacls or a failed read-back', async () => {
  const inheritedUsers = () => `${ownerOnlySddl()}(A;OICIID;0x1200a9;;;BU)`;
  for (const o of [{ icacls: icaclsFails }, { sddl: inheritedUsers }]) {
    const out = tmpDir('castsnap-loc-');
    await assert.rejects(
      mockPrivateExport({ out, export: { os: fakeWindows({ drive: NET, ...o }).os, allowUnsafeLocation: true } }),
      (e: Error) => e instanceof PrivacyError && !(e instanceof LocationRefused) && /could not be made readable by your account only/.test(e.message),
    );
    assert.deepEqual(fs.readdirSync(out), []);
  }
});

test('--private on Linux with unreadable mountinfo, and on macOS with a failed /sbin/mount, only warns', async () => {
  const unreadable = () => {
    throw new Error('EACCES');
  };
  const failedMount: RunCmd = () => ({ status: 1, stdout: '', stderr: '' });
  const cases = [
    { os: { platform: 'linux' as const, readText: unreadable }, label: 'a file system whose type could not be read' },
    { os: { platform: 'darwin' as const, run: failedMount }, label: 'a disk whose type could not be read' },
  ];
  for (const c of cases) {
    const r = await mockPrivateExport({ export: { os: c.os } });
    assert.ok(r.logs.includes(`castsnap: warning: the export folder is on ${c.label}. Other accounts, services or devices may be able to read what is written there.`), r.logs.join('\n'));
    assert.equal(readManifest(r.result.dir).privacy.location.label, c.label);
  }
});

test('an export without manifest.privacy and options.allowUnsafeLocation, as d8982ec made them, verifies the same on macOS and Linux, check by check', async () => {
  const dir = (await replayExport({ location: LOCAL })).dir as string;
  const verdicts = async (platform: 'darwin' | 'linux') => {
    const v = await verifyExport(dir, { os: { platform } });
    return { exitCode: v.exitCode, checks: v.checks.map((c) => `${c.id} ${c.verdict}`) };
  };
  const now = { darwin: await verdicts('darwin'), linux: await verdicts('linux') };
  // The manifest edited in place (an existing file keeps its mode), as d8982ec wrote it.
  const m = readManifest(dir);
  assert.ok(m.privacy && 'allowUnsafeLocation' in m.options, 'control: this export has both fields');
  delete m.privacy;
  delete m.options.allowUnsafeLocation;
  const text = `${JSON.stringify(m, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, 'manifest.json'), text);
  // SHA256SUMS covers manifest.json, so its line is rewritten too (AC-03).
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').split('\n');
  const at = sums.findIndex((l) => / manifest\.json$/.test(l));
  assert.ok(at >= 0 && sums.filter((l) => / manifest\.json$/.test(l)).length === 1, 'control: one SHA256SUMS line for manifest.json');
  sums[at] = `${createHash('sha256').update(text).digest('hex')}  manifest.json`;
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums.join('\n'));
  for (const platform of ['darwin', 'linux'] as const) {
    const before = await verdicts(platform);
    assert.ok(now[platform].checks.length > 10 && now[platform].checks.every((c) => !c.endsWith(' undefined')), 'control: verify ran its checks');
    assert.deepEqual(before, now[platform], platform);
  }
});

test('manifest.privacy, including privacy.location, and the Privacy: line hold no security ID and no path', async () => {
  // A --private run that runs the location check itself, and a public run whose permissions could not be set.
  const priv = await mockPrivateExport({ export: { os: fakeWindows().os } });
  const pub = await replayExport({ os: fakeWindows({ icacls: icaclsFails }).os });
  for (const [dir, logs] of [[priv.result.dir, priv.logs], [pub.dir as string, pub.logs]] as const) {
    const privacy = readManifest(dir).privacy;
    const line = logs.find((l) => l.startsWith('Privacy:'));
    assert.ok(privacy && line, 'control: the record and the line exist');
    for (const s of [JSON.stringify(privacy), line]) {
      assert.doesNotMatch(s, /S-1-/, s);
      assert.doesNotMatch(s, /[\\/]/, s);
    }
  }
  assert.match(readManifest(pub.dir as string).privacy.note, /icacls failed/, 'control: the public run recorded the failure');
});
