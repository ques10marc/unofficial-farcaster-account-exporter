// A fake Windows for tests on the Mac: a RunCmd keyed by executable name (whoami.exe, icacls.exe,
// powershell.exe). The export itself is written to a real temporary folder; the fake PowerShell lists
// the real items under CASTSNAP_ROOT and gives each the SDDL a test chooses.
import fs from 'node:fs';
import path from 'node:path';
import { DRIVE_SCRIPT, type DriveFacts } from '../src/location.ts';
import { ACL_SCRIPT, type OsDeps, type RunCmd, type RunResult } from '../src/permissions.ts';

export const FAKE_SID = 'S-1-5-21-1-2-3-1001';
export const OTHER_SID = 'S-1-5-21-1-2-3-1002';
export const FAKE_ENV: NodeJS.ProcessEnv = { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', SystemDrive: 'C:', USERPROFILE: 'C:\\Users\\Jörg' };

// The SDDL icacls /inheritance:r /grant:r *SID:(OI)(CI)F leaves: protected, owner-only.
export const ownerOnlySddl = (sid = FAKE_SID, owner = sid) => `O:${owner}G:${owner}D:PAI(A;OICI;FA;;;${sid})`;

export const ok = (stdout: string): RunResult => ({ status: 0, stdout, stderr: '' });

export interface Call {
  exe: string;
  file: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

export interface FakeWindowsOptions {
  whoami?: () => RunResult;
  // icacls's result; rootEmpty says whether the export folder was empty when it ran.
  icacls?: (call: Call, rootEmpty: boolean) => RunResult;
  // SDDL for each item, by its path relative to the export folder ('' is the folder itself).
  sddl?: (rel: string) => string;
  // Replaces the permission read entirely (failures, cut-off output).
  acl?: (call: Call) => RunResult;
  // Drive facts, or a raw result; null makes the drive-facts call fail.
  drive?: DriveFacts | null | ((call: Call) => RunResult);
}

export function fakeWindows(o: FakeWindowsOptions = {}) {
  const calls: Call[] = [];
  const icaclsSawEmpty: boolean[] = [];
  const run: RunCmd = (file, args, x) => {
    const call: Call = { exe: path.win32.basename(file).toLowerCase(), file, args, env: x.env, timeoutMs: x.timeoutMs };
    calls.push(call);
    if (call.exe === 'whoami.exe') return o.whoami ? o.whoami() : ok(`"PC\\Jörg","${FAKE_SID}"\r\n`);
    if (call.exe === 'icacls.exe') {
      const root = args[0];
      const empty = fs.existsSync(root) && fs.readdirSync(root).length === 0;
      icaclsSawEmpty.push(empty);
      return o.icacls ? o.icacls(call, empty) : ok('processed file\r\n');
    }
    if (call.exe === 'powershell.exe') {
      const script = args.at(-1);
      if (script === DRIVE_SCRIPT) {
        if (typeof o.drive === 'function') return o.drive(call);
        if (o.drive === null) return { status: 1, stdout: '', stderr: '' };
        return ok(JSON.stringify(o.drive ?? { type: 'Fixed', format: 'NTFS' }));
      }
      if (script === ACL_SCRIPT) {
        if (o.acl) return o.acl(call);
        const root = x.env.CASTSNAP_ROOT;
        const rels = [''];
        if (x.env.CASTSNAP_RECURSE === '1') {
          const walk = (d: string, rel: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              const r = rel ? `${rel}\\${e.name}` : e.name;
              rels.push(r);
              if (e.isDirectory()) walk(path.join(d, e.name), r);
            }
          };
          walk(root, '');
        }
        const sddl = o.sddl ?? (() => ownerOnlySddl());
        return ok(JSON.stringify(rels.map((rel) => ({ rel, sddl: sddl(rel) }))));
      }
    }
    return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('unexpected command'), { code: 'ENOENT' }) };
  };
  const os: Partial<OsDeps> = { platform: 'win32', run, env: FAKE_ENV };
  return { run, calls, icaclsSawEmpty, os };
}
