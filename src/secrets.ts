// Secret handling (SPEC "Secrets and privacy", AC-16).
//
// The session token is read from a hidden terminal prompt or from FC_SESSION_TOKEN. It lives in memory
// only: it is never written to disk or logged, every log line and error is redacted for it, it is sent
// only to the client API hosts below, and the finished export is scanned for it in several encodings
// before it is sealed.

import fs from 'node:fs';
import path from 'node:path';

export const TOKEN_ENV = 'FC_SESSION_TOKEN';

// The only places the session token is ever sent: the official client API host, the web app's proxy for
// it, and loopback addresses (local mock servers in tests). Anything else is refused.
export const TOKEN_HOSTS = ['https://client.farcaster.xyz', 'https://farcaster.xyz/~api'];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}

export function tokenHostAllowed(base: string): boolean {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return false;
  }
  if (u.username || u.password || u.search || u.hash) return false;
  if (LOOPBACK_HOSTS.has(u.hostname) && (u.protocol === 'http:' || u.protocol === 'https:')) return true;
  return u.protocol === 'https:' && TOKEN_HOSTS.includes(normalizeBase(`${u.protocol}//${u.host}${u.pathname}`));
}

export function normalizeToken(raw: string): string {
  return raw
    .replace(/\x1b\[20[01]~/g, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^authorization:\s*/i, '')
    .replace(/^bearer\s+/i, '')
    .trim();
}

// True when a value is one text twice over ("XX"), as when a paste into the hidden prompt is repeated
// because nothing appeared. Bracketed-paste markers and surrounding whitespace are ignored.
export function pastedTwice(s: string): boolean {
  const t = s.replace(/\x1b\[20[01]~/g, '').trim();
  const half = t.length / 2;
  return t.length >= 2 && Number.isInteger(half) && t.slice(0, half) === t.slice(half);
}

// A token with spaces or control characters would make fetch throw an error that quotes the header
// value, so it is rejected up front with a message that does not include it. A value pasted twice is
// refused first, before the length check, so a doubled short value gets that message. `typed` is the
// text before normalization, so "Bearer X" pasted twice is caught too.
export function checkTokenShape(token: string, typed = token): string | null {
  if (!token) return 'the token is empty';
  if (pastedTwice(typed) || pastedTwice(token)) return 'the token looks pasted twice (the same text two times in a row); run the command again and paste it once';
  if (!/^[\x21-\x7e]+$/.test(token)) return 'the token contains spaces or non-printable characters; copy only the value of the authorization header';
  if (token.length < 16) return 'the token is too short to be a session token';
  return null;
}

export function tokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[TOKEN_ENV];
  if (!raw) return undefined;
  const t = normalizeToken(raw);
  return t.length ? t : undefined;
}

// Input that arrives within this many ms of the prompt taking the terminal was typed or pasted before the
// question appeared, so the terminal may have shown it: it is discarded and counted, never used.
export const EARLY_INPUT_MS = 200;
const chars = (n: number) => `${n} character${n === 1 ? '' : 's'}`;
// An answer of only whitespace and bracketed-paste markers, as when Enter is pressed before pasting.
const blank = (s: string) => !s.replace(/\x1b\[20[01]~/g, '').trim();

// Reads one line from the terminal without echoing it. The question goes to stderr so that a redirected
// stdout never captures the prompt. Echo goes off first. Node can't flush or count input already waiting,
// so whatever arrives in the first earlyMs is treated as typed before the prompt: discarded, and reported
// by count on a line of its own, since the terminal may have left it on screen. Only then does the question
// appear. An empty answer asks again rather than exiting, so a paste that follows can't land in the shell;
// echo is still off, so there is no second wait. Ctrl+C cancels at any point. After Enter, only the number
// of characters received is shown, never the characters.
export function promptHidden(question: string, stdin: NodeJS.ReadStream = process.stdin, out: NodeJS.WriteStream = process.stderr, earlyMs = EARLY_INPUT_MS): Promise<string> {
  if (!stdin.isTTY) return Promise.reject(new Error(`No terminal for a hidden prompt; set ${TOKEN_ENV} instead.`));
  return new Promise((resolve, reject) => {
    let buf = '';
    let early = 0;
    let ready = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (err?: Error) => {
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      out.write(err ? '\n' : `${chars([...buf].length)} received.\n`);
      if (err) reject(err);
      else resolve(buf);
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\u0003') return finish(new Error('Cancelled'));
        if (!ready) {
          early++;
          continue;
        }
        if ((c === '\r' || c === '\n') && blank(buf)) {
          buf = '';
          out.write('Nothing was received. To cancel, press Ctrl+C.\n');
          out.write(question);
          continue;
        }
        if (c === '\r' || c === '\n') return finish();
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
    timer = setTimeout(() => {
      ready = true;
      if (early) out.write(`\nIgnored ${chars(early)} typed or pasted before this prompt was ready; they weren't used or sent. If that was your token, it may still show above, so close this window when you're done.\n`);
      out.write(question);
    }, earlyMs);
  });
}

// FC_SESSION_TOKEN first, else the hidden prompt. The token is registered for redaction before it is
// checked, so even a shape error cannot echo it.
export async function readSessionToken(opts: { env?: NodeJS.ProcessEnv; prompt?: () => Promise<string> } = {}): Promise<{ token: string; from: 'env' | 'prompt' }> {
  const env = tokenFromEnv(opts.env);
  const typed = env ?? (await (opts.prompt ?? (() => promptHidden('Paste your session token, then press Enter (nothing shows while you paste): ')))());
  const raw = env ?? normalizeToken(typed);
  // A value pasted with a stray space is refused below; its parts are registered too, so an echo of
  // either half is still redacted.
  registerSecret(raw);
  for (const part of raw.split(/\s+/)) if (part.length >= 8) registerSecret(part);
  const problem = checkTokenShape(raw, typed);
  if (problem) throw new Error(`Session token not usable: ${problem}.`);
  return { token: raw, from: env ? 'env' : 'prompt' };
}

// The forms a token could take if it leaked into a file: verbatim, URL-encoded, base64, hex.
export function secretVariants(secret: string): string[] {
  const v = new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')]);
  return [...v].filter((x) => x.length >= 8);
}

export function makeRedactor(secrets: (string | undefined)[]): (s: unknown) => string {
  const variants = secrets.filter((s): s is string => Boolean(s)).flatMap(secretVariants);
  return (s: unknown) => {
    let out = String(s);
    for (const v of variants) out = out.split(v).join('[REDACTED]');
    return out;
  };
}

// Process-wide registry, so the last-resort error handler can redact a token read from the prompt.
const registered = new Set<string>();
export function registerSecret(secret: string | undefined): void {
  if (secret) registered.add(secret);
}
export function redactRegistered(s: unknown): string {
  return makeRedactor([...registered, tokenFromEnv()])(s);
}

// An error message fit for a log line or a manifest status: redacted for every registered secret first,
// then cut to max characters, so a cut can never leave part of a token behind.
export function safeErrorText(e: unknown, max = 300): string {
  const s = redactRegistered(e instanceof Error ? e.message : e);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Text that may hold the token, redacted first and then cut to max characters with no mark, so a cut
// can never leave part of a token behind and a saved body still ends at exactly max characters.
export function redactThenCut(s: unknown, max: number, redact: (s: unknown) => string = redactRegistered): string {
  const r = redact(s);
  return r.length > max ? r.slice(0, max) : r;
}

// Returns the relative paths of files containing any variant of the secret. Reads bytes, so it also
// covers binary files (raw protobuf, media).
export function scanTreeForSecret(root: string, secret: string): { filesScanned: number; hits: string[] } {
  const variants = secretVariants(secret).map((v) => Buffer.from(v));
  const hits: string[] = [];
  let filesScanned = 0;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        filesScanned++;
        const buf = fs.readFileSync(p);
        if (variants.some((v) => buf.includes(v))) hits.push(path.relative(root, p));
      }
    }
  };
  walk(root);
  return { filesScanned, hits };
}

// Scans for several secrets at once (the token in use and any token in the environment).
export function scanTreeForSecrets(root: string, secrets: string[]): { filesScanned: number; hits: string[] } {
  let filesScanned = 0;
  const hits = new Set<string>();
  for (const s of secrets) {
    const r = scanTreeForSecret(root, s);
    filesScanned = Math.max(filesScanned, r.filesScanned);
    for (const h of r.hits) hits.add(h);
  }
  return { filesScanned, hits: [...hits].sort() };
}
