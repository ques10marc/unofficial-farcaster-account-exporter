// castsnap command line. See docs/SPEC.md "Interface".

import os from 'node:os';
import path from 'node:path';
import { ClientApi, CLIENT_BASES } from './client.ts';
import { AuthCheckError, parseMediaScope, runExport } from './export.ts';
import { findInExport, formatHits } from './find.ts';
import { normalizeBase, readSessionToken, redactRegistered, TOKEN_HOSTS, tokenHostAllowed } from './secrets.ts';
import { interrupt, VERSION } from './util.ts';
import { formatChecks, verifyExport } from './verify.ts';

const USAGE = `castsnap ${VERSION} - export a verifiable snapshot of one Farcaster account

Usage:
  castsnap export --fid N [--out DIR] [--private] [--media own,bookmarks|own|bookmarks|none] [--hub HOST] [--base URL]
  castsnap auth-check --fid N [--base URL]
  castsnap verify DIR [--json]
  castsnap find DIR <query>

export      Protocol data (gRPC ${'snap.farcaster.xyz:3383'}, falling back only to Farcaster's own Snapchain
            nodes) and client data.
            --out      parent directory for the new export (default ~/FarcasterExports)
            --private  also export bookmarks, direct casts, drafts, mutes and favourite mini apps,
                       using your web session token (hidden prompt, or FC_SESSION_TOKEN). The token is
                       checked against --fid before anything is written.
            --media    which casts' media to download (default own,bookmarks; bookmarks needs --private)
            --hub      gRPC host:port, or an https:// HTTP API base, tried first. Nodes other than
                       snap.farcaster.xyz and crackle.farcaster.xyz get no fallback
            --base     client API host (default ${CLIENT_BASES[0]}, falling back to ${CLIENT_BASES[1]});
                       only ${TOKEN_HOSTS.join(' or ')}, or a loopback address for testing
auth-check  Confirm the session token belongs to --fid (GET /v2/me). Writes nothing.
verify      Offline checks: checksums, signatures, schemas, CSVs, counts, acceptance criteria.
find        Search an export's normalized data (text, hash prefix, fid, username).

Exit codes: 0 ok; 1 errors, failed checks or a rejected token; 2 token found in output; 64 usage; 130 interrupted.`;

class UsageError extends Error {}
// A problem the user can fix (a token that cannot be read): printed without a stack trace.
class UserError extends Error {}

// A rejected argument or command is named only if it looks like one. Anything else may be a session token
// pasted in the wrong place, and usage errors end up in bug reports.
const named = (what: string, a: string) =>
  /^-{0,2}[A-Za-z][A-Za-z-]{0,30}$/.test(a)
    ? `${what}: ${a}`
    : `${what}, not shown in case it is your session token. If it is, it is now saved in your shell history: delete it from there, and paste the token only at the hidden prompt.`;

const getToken = () =>
  readSessionToken().catch((e: unknown) => {
    throw new UserError(e instanceof Error ? e.message : String(e));
  });

const DEFAULT_MEDIA = 'own,bookmarks';

function parseFlags(argv: string[], allowed: Set<string>) {
  const o: { fid?: number; out: string; media: string; hub?: string; base?: string; private: boolean } = { out: path.join(os.homedir(), 'FarcasterExports'), media: DEFAULT_MEDIA, private: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!allowed.has(a)) throw new UsageError(named('unknown argument', a));
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === '--fid') o.fid = Number(val());
    else if (a === '--out') o.out = val();
    else if (a === '--media') {
      const v = val();
      if (!parseMediaScope(v)) throw new UsageError('--media must be own, bookmarks, own,bookmarks or none');
      o.media = v;
    } else if (a === '--hub') o.hub = val();
    else if (a === '--base') {
      const v = normalizeBase(val());
      if (!tokenHostAllowed(v)) throw new UsageError(`--base must be ${TOKEN_HOSTS.join(' or ')}, or a loopback address (http://127.0.0.1:PORT) for testing`);
      o.base = v;
    } else if (a === '--private') o.private = true;
  }
  if (!Number.isInteger(o.fid) || (o.fid as number) <= 0) throw new UsageError('--fid must be a positive integer');
  return o as typeof o & { fid: number };
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE);
    return cmd ? 0 : 64;
  }
  if (cmd === '--version') {
    console.log(VERSION);
    return 0;
  }
  if (cmd === 'export') {
    const o = parseFlags(rest, new Set(['--fid', '--out', '--media', '--hub', '--base', '--private']));
    const token = o.private ? (await getToken()).token : undefined;
    process.on('SIGINT', () => {
      if (interrupt.requested) process.exit(130);
      interrupt.requested = true;
      console.log('\nInterrupted: finishing the current request, then writing the manifest...');
    });
    try {
      const r = await runExport({ ...o, token });
      return r.exitCode;
    } catch (e) {
      if (e instanceof AuthCheckError) {
        console.error(redactRegistered(e.message));
        return 1;
      }
      throw e;
    }
  }
  if (cmd === 'auth-check') {
    const o = parseFlags(rest, new Set(['--fid', '--base']));
    const { token } = await getToken();
    const client = new ClientApi({ token, bases: o.base ? [o.base] : CLIENT_BASES, explicitBase: Boolean(o.base) });
    const r = await client.authCheck(o.fid);
    console.log(redactRegistered(`auth-check: ${r.ok ? 'OK' : 'FAILED'}. ${r.message}${r.ok ? '' : ' Nothing was written.'}`));
    return r.ok ? 0 : 1;
  }
  if (cmd === 'verify') {
    const dir = rest.find((a) => !a.startsWith('--'));
    if (!dir) throw new UsageError('verify needs a directory');
    const r = await verifyExport(dir, { progress: (s) => console.error(s) });
    if (rest.includes('--json')) console.log(JSON.stringify(r.checks, null, 2));
    else console.log(formatChecks(path.resolve(dir), r.checks));
    return r.exitCode;
  }
  if (cmd === 'find') {
    const [dir, ...q] = rest;
    if (!dir || !q.length) throw new UsageError('find needs a directory and a query');
    const hits = findInExport(dir, q.join(' '));
    console.log(formatHits(hits));
    return hits.length ? 0 : 1;
  }
  throw new UsageError(named('unknown command', cmd));
}

// The last resort for errors, including any thrown outside main()'s promise chain, which Node would
// otherwise print unredacted.
const crash = (e: unknown) => {
  console.error(`Error: ${redactRegistered(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exit(1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${USAGE}`);
      process.exit(64);
    }
    if (e instanceof UserError) {
      console.error(`Error: ${redactRegistered(e.message)}`);
      process.exit(1);
    }
    crash(e);
  },
);
