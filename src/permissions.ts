// Owner-only permissions for an export folder, and the Windows permission reader that verify's AC-16
// shares with the export. Node built-ins only: cli.ts loads this before the token prompt.
//
// macOS and Linux: the writer creates the folder 0700; makeOwnerOnly reads the mode back.
// Windows: modes do nothing, so icacls removes inherited entries and grants only the user's security ID
// (from whoami), then PowerShell reads the folder's permissions back as SDDL. Output never shows a
// security ID: problems are named in fixed English words.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
export type RunCmd = (file: string, args: string[], o: { env: Record<string, string>; timeoutMs: number }) => RunResult;

export interface OsDeps {
  platform: NodeJS.Platform;
  run: RunCmd;
  env: NodeJS.ProcessEnv;
  modeOf: (p: string) => number;
  readText: (p: string) => string;
}

const defaultRun: RunCmd = (file, args, o) => {
  const r = spawnSync(file, args, { env: o.env, timeout: o.timeoutMs, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: r.error } : {}) };
};

export const osDeps = (p: Partial<OsDeps> = {}): OsDeps => ({
  platform: p.platform ?? process.platform,
  run: p.run ?? defaultRun,
  env: p.env ?? process.env,
  modeOf: p.modeOf ?? ((x: string) => fs.statSync(x).mode),
  readText: p.readText ?? ((x: string) => fs.readFileSync(x, 'utf8')),
});

// Stopped a --private run (or failed AC-16) because the folder could not be made owner-only.
export class PrivacyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivacyError';
  }
}

// Windows PowerShell 5.1 may still start its output with a byte-order mark.
export const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// The only variables a Windows child command gets, each only when set, plus the call's own extras.
// FC_SESSION_TOKEN never reaches a child process.
export const CHILD_ENV_KEYS = ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA'] as const;
export function childEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CHILD_ENV_KEYS) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (k.toUpperCase() !== 'FC_SESSION_TOKEN') out[k] = v;
  return out;
}

// Absolute paths under %SystemRoot%, so a program planted in the current folder or on PATH is never run.
// No SystemRoot, or one without a drive letter: fail closed, never fall back to a bare name.
const SYSTEM_EXES = {
  icacls: 'System32\\icacls.exe',
  whoami: 'System32\\whoami.exe',
  powershell: 'System32\\WindowsPowerShell\\v1.0\\powershell.exe',
} as const;
export type SystemExe = keyof typeof SYSTEM_EXES;
export function systemExe(env: NodeJS.ProcessEnv, name: SystemExe): string {
  const root = env.SystemRoot;
  if (!root || !/^[A-Za-z]:[\\/]/.test(root)) throw new PrivacyError('SystemRoot is not set to an absolute path, so the Windows tools could not be found safely');
  return path.win32.join(root, SYSTEM_EXES[name]);
}

export function runSystem(d: OsDeps, name: SystemExe, args: string[], extra: Record<string, string> = {}, timeoutMs = 60_000): RunResult {
  return d.run(systemExe(d.env, name), args, { env: childEnv(d.env, extra), timeoutMs });
}

const failed = (r: RunResult) => Boolean(r.error) || r.status !== 0;
const why = (what: string, r: RunResult) => `${what} ${r.error ? `did not run (${(r.error as NodeJS.ErrnoException).code ?? 'error'})` : `failed (exit status ${r.status})`}`;

const isUserSid = (sid: string | null) => sid !== null && /^S-1-5-21(-\d+)+$/.test(sid);

// The SID column of `whoami /user /fo csv /nh`: the last quoted field, never the account name.
export function currentUserSid(d: OsDeps): string {
  const r = runSystem(d, 'whoami', ['/user', '/fo', 'csv', '/nh']);
  if (failed(r)) throw new PrivacyError(why('whoami', r));
  const fields = [...stripBom(r.stdout).trim().matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]);
  const sid = fields.at(-1) ?? '';
  // Entra ID (work or school) accounts have S-1-12-1-… IDs; only S-1-5-21-… user accounts are supported.
  if (/^S-1-12-1-/.test(sid)) throw new PrivacyError('This kind of Windows account (a work or school account) is not supported for --private yet');
  if (!isUserSid(sid)) throw new PrivacyError('whoami did not report a user security ID for this account');
  return sid;
}

// Reads the SDDL of the folder (and, with recurse, everything under it). The path arrives only through
// CASTSNAP_ROOT, and the script contains no double quote.
export const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '$top = Get-Item -LiteralPath $env:CASTSNAP_ROOT -Force',
  '$items = @($top)',
  "if ($env:CASTSNAP_RECURSE -eq '1') { $items += @(Get-ChildItem -LiteralPath $top.FullName -Recurse -Force) }",
  "$out = foreach ($i in $items) { [pscustomobject]@{ rel = $i.FullName.Substring($top.FullName.Length).TrimStart('\\'); sddl = (Get-Acl -LiteralPath $i.FullName).Sddl } }",
  'ConvertTo-Json -InputObject @($out) -Compress',
].join('\n');

export interface AclEntry {
  rel: string;
  sddl: string;
}
export type AclRead = { ok: true; entries: AclEntry[] } | { ok: false; problem: string };

export function parseAclJson(stdout: string): AclEntry[] | null {
  try {
    const v: unknown = JSON.parse(stripBom(stdout).trim());
    const list = Array.isArray(v) ? v : [v];
    if (!list.length || !list.every((e) => e && typeof e === 'object' && typeof e.rel === 'string' && typeof e.sddl === 'string')) return null;
    return list as AclEntry[];
  } catch {
    return null;
  }
}

export function readWindowsAcls(root: string, d: OsDeps, recurse: boolean): AclRead {
  let r: RunResult;
  try {
    r = runSystem(d, 'powershell', ['-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT], { CASTSNAP_ROOT: root, CASTSNAP_RECURSE: recurse ? '1' : '0' }, recurse ? 600_000 : 60_000);
  } catch (e) {
    return { ok: false, problem: e instanceof PrivacyError ? e.message : 'PowerShell could not be started' };
  }
  if (failed(r)) return { ok: false, problem: why('PowerShell', r) };
  const entries = parseAclJson(r.stdout);
  if (!entries) return { ok: false, problem: 'PowerShell printed no readable permission list' };
  return { ok: true, entries };
}

// ---------- SDDL ----------

export interface Ace {
  allow: boolean;
  inherited: boolean;
  sid: string;
}
export interface ParsedSd {
  owner: string | null;
  daclPresent: boolean;
  nullDacl: boolean;
  protected: boolean;
  aces: Ace[];
}

const ALLOW_TYPES = new Set(['A', 'OA', 'XA', 'ZA']);

// Splits O:, G:, D: and S: outside parentheses. A section letter followed by ':' can't occur inside a
// security ID (S-1-…), a two-letter alias or the DACL flags, so it always starts a section.
export function parseDacl(sddl: string): ParsedSd {
  const s = stripBom(sddl).trim();
  const parts: Record<string, string> = {};
  let key = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && 'OGDS'.includes(c) && s[i + 1] === ':') {
      key = c;
      parts[key] = '';
      i++;
      continue;
    }
    if (key) parts[key] += c;
  }
  const d = parts.D;
  const daclPresent = d !== undefined;
  const flags = daclPresent ? d.slice(0, d.indexOf('(') === -1 ? d.length : d.indexOf('(')) : '';
  const nullDacl = flags.includes('NO_ACCESS_CONTROL');
  const aces: Ace[] = [];
  if (daclPresent) {
    for (const m of d.matchAll(/\(([^()]*)\)/g)) {
      const f = m[1].split(';');
      aces.push({ allow: ALLOW_TYPES.has(f[0]), inherited: (f[1] ?? '').includes('ID'), sid: f[5] ?? '' });
    }
  }
  return { owner: parts.O || null, daclPresent, nullDacl, protected: /P/.test(flags.replace('NO_ACCESS_CONTROL', '')), aces };
}

// One set of rules for the export's read-back and for AC-16. entries[0] is the export folder.
export interface OwnerOnlyCheck {
  ok: boolean;
  problems: string[];
  inheritanceRemoved: boolean;
  itemsGivingOthers: number;
  total: number;
}
export function checkOwnerOnly(entries: AclEntry[]): OwnerOnlyCheck {
  const top = entries[0] ? parseDacl(entries[0].sddl) : null;
  const problems: string[] = [];
  if (!top) return { ok: false, problems: ['no permission list was read'], inheritanceRemoved: false, itemsGivingOthers: 0, total: 0 };
  if (!top.protected) problems.push('inheritance not removed');
  if (!top.daclPresent || top.nullDacl) problems.push('no permission list, or an empty (null) one that allows everyone');
  if (!isUserSid(top.owner)) problems.push('the owner is not a user account');
  let itemsGivingOthers = 0;
  for (const e of entries) {
    const sd = parseDacl(e.sddl);
    // An item owned by another account gives that account access: an owner can always change the permissions.
    const others = !sd.daclPresent || sd.nullDacl || sd.owner !== top.owner || sd.aces.some((a) => a.allow && a.sid !== top.owner);
    if (others) itemsGivingOthers++;
  }
  if (itemsGivingOthers) problems.push('access for other accounts');
  return { ok: problems.length === 0, problems, inheritanceRemoved: top.protected, itemsGivingOthers, total: entries.length };
}

// ---------- making the export folder owner-only ----------

export interface OwnerOnlyResult {
  method: 'posix-mode' | 'windows-acl';
  ok: boolean;
  problem?: string;
}

export function makeOwnerOnly(root: string, d: OsDeps): OwnerOnlyResult {
  if (d.platform !== 'win32') {
    let mode: number;
    try {
      mode = d.modeOf(root);
    } catch {
      return { method: 'posix-mode', ok: false, problem: "the folder's permissions could not be read back" };
    }
    return (mode & 0o077) === 0 ? { method: 'posix-mode', ok: true } : { method: 'posix-mode', ok: false, problem: 'the folder is open to other accounts' };
  }
  try {
    const sid = currentUserSid(d);
    const r = runSystem(d, 'icacls', [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]);
    if (failed(r)) return { method: 'windows-acl', ok: false, problem: why('icacls', r) };
    const read = readWindowsAcls(root, d, false);
    if (!read.ok) return { method: 'windows-acl', ok: false, problem: read.problem };
    const c = checkOwnerOnly(read.entries);
    return c.ok ? { method: 'windows-acl', ok: true } : { method: 'windows-acl', ok: false, problem: `the permissions read back are not owner-only: ${c.problems.join('; ')}` };
  } catch (e) {
    return { method: 'windows-acl', ok: false, problem: e instanceof PrivacyError ? e.message : 'the Windows permissions could not be set' };
  }
}
