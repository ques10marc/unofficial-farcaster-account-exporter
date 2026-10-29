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

// A token with spaces or control characters would make fetch throw an error that quotes the header
// value, so it is rejected up front with a message that does not include it.
export function checkTokenShape(token: string): string | null {
  if (!token) return 'the token is empty';
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

// Reads one line from the terminal without echoing it. The question goes to stderr so that a redirected
// stdout never captures the prompt.
export function promptHidden(question: string, stdin: NodeJS.ReadStream = process.stdin, out: NodeJS.WriteStream = process.stderr): Promise<string> {
  if (!stdin.isTTY) return Promise.reject(new Error(`No terminal for a hidden prompt; set ${TOKEN_ENV} instead.`));
  out.write(question);
  return new Promise((resolve, reject) => {
    let buf = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      out.write('\n');
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          cleanup();
          resolve(buf);
          return;
        }
        if (c === '\u0003') {
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

// FC_SESSION_TOKEN first, else the hidden prompt. The token is registered for redaction before it is
// checked, so even a shape error cannot echo it.
export async function readSessionToken(opts: { env?: NodeJS.ProcessEnv; prompt?: () => Promise<string> } = {}): Promise<{ token: string; from: 'env' | 'prompt' }> {
  const env = tokenFromEnv(opts.env);
  const raw = env ?? normalizeToken(await (opts.prompt ?? (() => promptHidden('Paste session token (input hidden), then Enter: ')))());
  // A value pasted with a stray space is refused below; its parts are registered too, so an echo of
  // either half is still redacted.
  registerSecret(raw);
  for (const part of raw.split(/\s+/)) if (part.length >= 8) registerSecret(part);
  const problem = checkTokenShape(raw);
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
