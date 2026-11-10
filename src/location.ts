// Where an export may be written. --private refuses synced, network and no-permission locations unless
// --allow-unsafe-location is given; public runs warn. Node built-ins and permissions.ts only: cli.ts runs
// this before the token prompt.
//
// A result holds only a kind and a fixed label, never a path, mount point or volume name. The facts read
// from the system (/sbin/mount's output, /proc/self/mountinfo, the drive facts) are only parsed: never
// printed, logged or written into an export.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type OsDeps, PrivacyError, runSystem, stripBom } from './permissions.ts';

export type LocationKind = 'local' | 'synced' | 'network' | 'no-permissions' | 'unknown';
// refuse: refused for --private (warned on public runs and with the override); warn: warned on every run.
export type LocationLevel = 'ok' | 'warn' | 'refuse';
export interface Location {
  kind: LocationKind;
  level: LocationLevel;
  label: string;
}
const at = (kind: LocationKind, level: LocationLevel, label: string): Location => ({ kind, level, label });

const LOCAL = at('local', 'ok', 'a local folder');
const W_UNC = at('network', 'refuse', 'a network path (a UNC or WSL path)');
const W_ONEDRIVE = at('synced', 'refuse', 'a OneDrive folder');
const W_UNKNOWN = at('unknown', 'refuse', 'a drive whose type could not be read');
const W_MAPPED = at('network', 'refuse', 'a mapped network drive');
const W_FAT = at('no-permissions', 'refuse', 'a FAT32 or exFAT drive, which has no permissions');
const W_SYNC_NAME = at('synced', 'warn', 'a folder that looks synced (Dropbox, Google Drive or iCloud Drive)');
const W_REMOVABLE = at('local', 'warn', 'a removable drive');
const M_CLOUD = at('synced', 'refuse', 'an iCloud Drive, Dropbox or other cloud storage folder');
const M_NET = at('network', 'refuse', 'a network mount');
const M_FAT = at('no-permissions', 'refuse', 'an MS-DOS (FAT) or exFAT disk, which has no permissions');
const M_FUSE = at('unknown', 'warn', 'a FUSE file system');
const M_UNREAD = at('unknown', 'warn', 'a disk whose type could not be read');
const L_NET = at('network', 'refuse', 'a network or shared file system');
const L_FAT = at('no-permissions', 'refuse', 'a FAT or exFAT file system, which has no permissions');
const L_FUSE = at('unknown', 'warn', 'a FUSE file system');
const L_UNREAD = at('unknown', 'warn', 'a file system whose type could not be read');
const OTHER = at('unknown', 'warn', 'a location this system cannot check');

// p is base or lies under it, at a path boundary.
function under(p: string, base: string, sep: string, fold: boolean): boolean {
  const a = fold ? p.toLowerCase() : p;
  let b = fold ? base.toLowerCase() : base;
  while (b.length > 1 && b.endsWith(sep)) b = b.slice(0, -1);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

// ---------- Windows ----------

export interface DriveFacts {
  type: string;
  format: string;
}

// The path arrives only through CASTSNAP_ROOT, and the script contains no double quote.
export const DRIVE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '$d = New-Object System.IO.DriveInfo -ArgumentList ([System.IO.Path]::GetPathRoot($env:CASTSNAP_ROOT))',
  'ConvertTo-Json -InputObject ([pscustomobject]@{ type = [string]$d.DriveType; format = [string]$d.DriveFormat }) -Compress',
].join('\n');

export function parseDriveJson(stdout: string): DriveFacts | null {
  try {
    const v: unknown = JSON.parse(stripBom(stdout).trim());
    if (!v || typeof v !== 'object') return null;
    const { type, format } = v as Record<string, unknown>;
    return typeof type === 'string' && typeof format === 'string' ? { type, format } : null;
  } catch {
    return null;
  }
}

// Any failure (no SystemRoot, an error, a cut-off buffer, a timeout, a non-zero or missing status, output
// that doesn't parse) gives null, which refuses --private.
export function readDriveFacts(abs: string, d: OsDeps): DriveFacts | null {
  try {
    const r = runSystem(d, 'powershell', ['-NoProfile', '-NonInteractive', '-Command', DRIVE_SCRIPT], { CASTSNAP_ROOT: abs });
    if (r.error || r.status !== 0) return null;
    return parseDriveJson(r.stdout);
  } catch {
    return null;
  }
}

const isUnc = (p: string) => p.startsWith('\\\\') && !/^\\\\[?.]\\[A-Za-z]:/.test(p);

// drive: the drive facts, or null if they could not be read; not needed for UNC paths.
export function classifyWindows(abs: string, env: NodeJS.ProcessEnv, drive?: DriveFacts | null): Location {
  let p = abs.replace(/\//g, '\\');
  if (isUnc(p)) return W_UNC;
  if (p.startsWith('\\\\')) p = p.slice(4);
  p = path.win32.normalize(p);
  for (const k of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    const v = env[k];
    if (v && path.win32.isAbsolute(v) && under(p, path.win32.normalize(v), '\\', true)) return W_ONEDRIVE;
  }
  if (!drive) return W_UNKNOWN;
  if (/^network$/i.test(drive.type)) return W_MAPPED;
  if (/^(fat|fat32|exfat)$/i.test(drive.format)) return W_FAT;
  if (p.split('\\').some((s) => /^(dropbox|google drive|icloud ?drive)$/i.test(s))) return W_SYNC_NAME;
  if (/^removable$/i.test(drive.type)) return W_REMOVABLE;
  return LOCAL;
}

// ---------- macOS ----------

// mountText: /sbin/mount's output, or null if it could not be read. Lines look like
// "//user@server/My Share on /Volumes/My Share (smbfs, nodev, nosuid, mounted by user)".
export function classifyMac(abs: string, home: string, mountText: string | null): Location {
  for (const rel of ['Library/Mobile Documents', 'Library/CloudStorage', 'Dropbox']) {
    if (home && under(abs, path.posix.join(home, rel), '/', true)) return M_CLOUD;
  }
  if (mountText === null) return M_UNREAD;
  let best: { point: string; type: string; opts: string[] } | null = null;
  for (const line of mountText.split('\n')) {
    const m = /^(.+) \(([^()]*)\)$/.exec(line.trim());
    if (!m) continue;
    const [type, ...opts] = m[2].split(',').map((s) => s.trim());
    // A device name can itself contain " on ", so every split whose mount point starts with "/" counts
    // as a mount point of this line's type.
    for (let i = m[1].indexOf(' on '); i !== -1; i = m[1].indexOf(' on ', i + 1)) {
      const point = m[1].slice(i + 4);
      if (point.startsWith('/') && under(abs, point, '/', true) && (!best || point.length >= best.point.length)) best = { point, type, opts };
    }
  }
  if (!best) return M_UNREAD;
  const t = best.type.toLowerCase();
  if (t === 'msdos' || t === 'exfat') return M_FAT;
  if (['smbfs', 'afpfs', 'nfs', 'webdav'].includes(t)) return M_NET;
  if (t.includes('fuse')) return M_FUSE;
  if (!best.opts.includes('local')) return M_NET;
  return LOCAL;
}

// ---------- Linux ----------

const unescapeMount = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

// mountinfo: /proc/self/mountinfo, or null if it could not be read. The longest mount point wins.
export function classifyLinux(abs: string, mountinfo: string | null): Location {
  if (mountinfo === null) return L_UNREAD;
  let best: { point: string; type: string } | null = null;
  for (const line of mountinfo.split('\n')) {
    const f = line.split(' ');
    const dash = f.indexOf('-', 6);
    if (dash < 0 || f.length < dash + 2) continue;
    const point = unescapeMount(f[4]);
    if (under(abs, point, '/', false) && (!best || point.length >= best.point.length)) best = { point, type: f[dash + 1] };
  }
  if (!best) return L_UNREAD;
  const t = best.type.toLowerCase();
  if (/^(vfat|msdos|exfat)$/.test(t)) return L_FAT;
  if (/^nfs/.test(t) || /^(cifs|smb3|smbfs|9p|virtiofs|vboxsf|fuse\.sshfs|fuse\.rclone)$/.test(t)) return L_NET;
  if (t.startsWith('fuse')) return L_FUSE;
  return LOCAL;
}

// ---------- the check ----------

function nearestExisting(p: string): string {
  for (let c = p; ; c = path.dirname(c)) {
    try {
      return fs.realpathSync.native(c);
    } catch {
      if (path.dirname(c) === c) return c;
    }
  }
}

function realHome(d: OsDeps): string {
  const h = d.env.HOME || os.homedir();
  try {
    return fs.realpathSync.native(h);
  } catch {
    return h;
  }
}

export const MOUNT_EXE = '/sbin/mount';

// Classifies the nearest existing folder at or above out, the parent the export folder is created in.
export function checkLocation(out: string, d: OsDeps): Location {
  const abs = nearestExisting(path.resolve(out));
  if (d.platform === 'win32') return isUnc(abs.replace(/\//g, '\\')) ? classifyWindows(abs, d.env) : classifyWindows(abs, d.env, readDriveFacts(abs, d));
  if (d.platform === 'darwin') {
    // No arguments: it only lists the mounts. Its output is only parsed.
    const r = d.run(MOUNT_EXE, [], { env: {}, timeoutMs: 10_000 });
    return classifyMac(abs, realHome(d), r.error || r.status !== 0 ? null : r.stdout);
  }
  if (d.platform === 'linux') {
    let text: string | null;
    try {
      text = d.readText('/proc/self/mountinfo');
    } catch {
      text = null;
    }
    return classifyLinux(abs, text);
  }
  return OTHER;
}

// Stopped a --private run because of where it would write. A PrivacyError, so callers handle both alike.
export class LocationRefused extends PrivacyError {
  constructor(message: string) {
    super(message);
    this.name = 'LocationRefused';
  }
}

export interface LocationChoice {
  private: boolean;
  allowUnsafeLocation?: boolean;
}

// The one decision both cli.ts and runExport use, so they can't disagree.
export function decideLocation(l: Location, o: LocationChoice): LocationLevel {
  if (l.level === 'refuse') return o.private && !o.allowUnsafeLocation ? 'refuse' : 'warn';
  return l.level;
}

export function locationMessage(l: Location, o: LocationChoice): string {
  if (decideLocation(l, o) === 'refuse') {
    return `castsnap: --private stopped: the export folder would be on ${l.label}, where other accounts, services or devices may be able to read it. Choose a local folder with --out, or add --allow-unsafe-location to accept this. Nothing was written and no token was sent.`;
  }
  const why = l.level !== 'refuse' ? '' : o.private ? ' (allowed by --allow-unsafe-location)' : '; --private would refuse it';
  return `castsnap: warning: the export folder is on ${l.label}${why}. Other accounts, services or devices may be able to read what is written there.`;
}

// Throws LocationRefused, or passes a warning to warn; says nothing for an ordinary local folder.
export function applyLocation(l: Location, o: LocationChoice, warn: (s: string) => void): void {
  const dec = decideLocation(l, o);
  if (dec === 'refuse') throw new LocationRefused(locationMessage(l, o));
  if (dec === 'warn') warn(locationMessage(l, o));
}
