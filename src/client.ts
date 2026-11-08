// Farcaster client API: public endpoints (no auth) and, with a session token, the private ones.
// Endpoint paths and limits come from the official client's types.yml (snapshot 2026-09-30, commit
// 0c289ed): /v2/following and /v2/followers return at most 50 per page and allow 20 requests per 10 s and
// 500 per hour. The public limiter applies those limits to every public request, which is stricter than
// needed for the other public endpoints but keeps one simple rule. The private GET endpoints declare no
// rate limit, so they are paced conservatively at one request per 600 ms.
//
// The session token is sent only on requests marked auth, only to the hosts in secrets.TOKEN_HOSTS (or a
// loopback mock), and redirects are never followed with it.

import { safeErrorText, tokenHostAllowed } from './secrets.ts';
import { interrupt, RateLimiter, sleep } from './util.ts';

export const CLIENT_BASES = ['https://client.farcaster.xyz', 'https://farcaster.xyz/~api'];
const TIMEOUT_MS = 30_000;
// Network errors (no response, or a body that fails mid-read) are retried with waits of 2, 4, 8, 16, 32
// and then 60 s: about 5 minutes in all, enough to ride out a Wi-Fi reconnect.
const NETWORK_ATTEMPTS = 10;
// The first error message of an error body, for a note: "errors[0].message: …", at most 200 characters.
const firstError = (text: string): string | undefined => {
  try {
    const m = JSON.parse(text)?.errors?.[0]?.message;
    return typeof m === 'string' ? `errors[0].message: ${m.slice(0, 200)}` : undefined;
  } catch {
    return undefined;
  }
};

export interface ClientResponse {
  status: number;
  text: string;
  url: string;
  error?: string;
}

export interface ClientPaged {
  status: string; // complete | empty | unavailable:<code> | error:<reason> | interrupted
  base: string;
  pages: string[]; // verbatim response bodies
  items: unknown[];
  lastCursorEmpty: boolean;
  limitUsed?: number;
  errorBody?: string;
}

// Pages of an endpoint whose answer shape is not documented (pagesRaw).
export interface RawPages {
  status: string; // complete | unavailable:<code> | unavailable:no-result | unavailable:non-json | error:<reason> | interrupted
  base: string;
  pages: string[]; // verbatim 200 bodies that carried a result
  bodies: unknown[]; // the same, parsed
  lastCursorEmpty: boolean;
  errorBody?: string;
  note?: string;
}

export interface ClientOptions {
  bases?: string[];
  // true when the user chose the host (--base): no host fallback, for public or private requests.
  explicitBase?: boolean;
  // Session token for private endpoints. Never sent on public requests.
  token?: string;
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  privateLimiter?: RateLimiter;
  wait?: (ms: number) => Promise<void>;
  log?: (s: string) => void;
}

export interface RequestOptions {
  base?: string;
  auth?: boolean;
}

export interface AuthCheck {
  ok: boolean;
  status: number; // HTTP status of the last /v2/me attempt (0: no response)
  base: string;
  attempts: { base: string; status: number; error?: string }[];
  fid?: number;
  username?: string;
  text?: string; // verbatim /v2/me body when ok
  message: string;
}

export class ClientApi {
  readonly bases: string[];
  readonly explicitBase: boolean;
  private base: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly privateLimiter: RateLimiter;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly log: (s: string) => void;
  requests = 0;
  // Set once a request has used up its network retries. Later requests then try once each until a
  // response gets through, so a long outage costs one full set of retries, not one per request.
  private networkDown = false;

  constructor(opts: ClientOptions = {}) {
    this.bases = opts.bases ?? CLIENT_BASES;
    this.explicitBase = opts.explicitBase ?? false;
    this.base = this.bases[0];
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.wait = opts.wait ?? sleep;
    this.limiter = opts.limiter ?? new RateLimiter({ windows: [{ max: 20, ms: 10_000 }, { max: 500, ms: 3_600_000 }], minGapMs: 500, wait: this.wait });
    this.privateLimiter = opts.privateLimiter ?? new RateLimiter({ windows: [], minGapMs: 600, wait: this.wait });
    this.log = opts.log ?? (() => {});
  }

  get currentBase(): string {
    return this.base;
  }

  get hasToken(): boolean {
    return Boolean(this.token);
  }

  // One GET with 429 / 5xx / network backoff. Public requests never carry an Authorization header.
  async get(path: string, params: Record<string, string | number | undefined>, o: RequestOptions = {}): Promise<ClientResponse> {
    const base = o.base ?? this.base;
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (o.auth) {
      if (!this.token) return { status: 0, text: '', url: url.toString(), error: 'no session token' };
      if (!tokenHostAllowed(base)) return { status: 0, text: '', url: url.toString(), error: `refused to send the session token to ${base}` };
      headers.authorization = `Bearer ${this.token}`;
    }
    const limiter = o.auth ? this.privateLimiter : this.limiter;
    let backoff = 0;
    for (let attempt = 1; ; attempt++) {
      const waited = await limiter.take();
      if (waited > 5000) this.log(`    rate budget: waited ${Math.round(waited / 1000)}s`);
      this.requests++;
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(url, { headers, redirect: o.auth ? 'manual' : 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
        // The timeout also covers the body, so a connection that dies mid-body is retried like one that
        // never answered.
        text = await res.text();
      } catch (e) {
        // The error ends up in a source's status in the manifest, so it gets the status length cap.
        if (attempt >= (this.networkDown ? 1 : NETWORK_ATTEMPTS) || interrupt.requested) {
          if (!this.networkDown && !interrupt.requested) {
            this.networkDown = true;
            this.log(`    network still failing after ${NETWORK_ATTEMPTS} attempts; later requests try once each until one gets through`);
          }
          return { status: 0, text: '', url: url.toString(), error: safeErrorText(e, 200) };
        }
        const ms = Math.min(60_000, 2000 * 2 ** (attempt - 1));
        this.log(`    network error, retry ${attempt} in ${Math.round(ms / 1000)}s: ${safeErrorText(e)}`);
        await this.wait(ms);
        continue;
      }
      // Any response, whatever its status, shows the network is back.
      if (this.networkDown) {
        this.networkDown = false;
        this.log('    network back: requests get full retries again');
      }
      if (res.status === 429 && attempt <= 12 && !interrupt.requested) {
        const ra = Number(res.headers.get('retry-after'));
        backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(15 * 60_000, Math.max(30_000, backoff * 2));
        this.log(`    rate limited (429); waiting ${Math.round(backoff / 1000)}s`);
        await this.wait(backoff);
        continue;
      }
      if (res.status >= 500 && attempt < 6 && !interrupt.requested) {
        await this.wait(Math.min(60_000, 2000 * 2 ** (attempt - 1)));
        continue;
      }
      return { status: res.status, text, url: url.toString() };
    }
  }

  // GET with host fallback: if the primary host fails on the first request (network error, 5xx or
  // 404), the same request is tried on the next host, which then stays current for the run. No fallback
  // when the user chose the host.
  async getWithFallback(path: string, params: Record<string, string | number | undefined>, o: RequestOptions = {}): Promise<ClientResponse> {
    const first = await this.get(path, params, o);
    if (this.explicitBase || !(first.status === 0 || first.status >= 500 || first.status === 404)) return first;
    for (const b of this.bases) {
      if (b === this.base) continue;
      const alt = await this.get(path, params, { ...o, base: b });
      if (alt.status === 200) {
        this.log(`    client API: switched host ${this.base} -> ${b}`);
        this.base = b;
        return alt;
      }
    }
    return first;
  }

  // GET /v2/me with the session token. If the first host rejects it (401/403) or fails, and the user did
  // not choose the host, the web app's own proxy host is tried, as the quick capture does. The host that
  // accepts the token stays current for the run.
  async authCheck(expectedFid?: number): Promise<AuthCheck> {
    const attempts: { base: string; status: number; error?: string }[] = [];
    const order = this.explicitBase ? [this.base] : [this.base, ...this.bases.filter((b) => b !== this.base)];
    let last: ClientResponse | undefined;
    let base = this.base;
    for (const b of order) {
      last = await this.get('/v2/me', {}, { auth: true, base: b });
      attempts.push({ base: b, status: last.status, ...(last.error ? { error: last.error } : {}) });
      base = b;
      if (last.status === 200) break;
      if (!(last.status === 0 || last.status === 401 || last.status === 403 || last.status === 404 || last.status >= 500)) break;
    }
    const tried = attempts.map((a) => `${a.status ? `HTTP ${a.status}` : `no response (${a.error ?? 'unknown error'})`} at ${a.base}`).join(', ');
    // A rejected token may be one pasted twice into the hidden prompt; saying so first spares a needless
    // new sign-in.
    const rejected = attempts.some((a) => a.status === 401 || a.status === 403);
    const advice = rejected ? 'If you pasted more than once, run the command again and paste once. If it still fails, copy a fresh token and retry.' : 'Copy a fresh token and retry.';
    if (!last || last.status !== 200) return { ok: false, status: last?.status ?? 0, base, attempts, message: `Token check failed: /v2/me returned ${tried}. ${advice}` };
    let user: { fid?: unknown; username?: unknown } | undefined;
    try {
      user = JSON.parse(last.text)?.result?.user;
    } catch {}
    if (!Number.isInteger(user?.fid)) return { ok: false, status: 200, base, attempts, message: 'Unexpected /v2/me response shape (no result.user.fid).' };
    const fid = user!.fid as number;
    const username = typeof user!.username === 'string' ? user!.username : undefined;
    this.base = base;
    if (expectedFid !== undefined && fid !== expectedFid) return { ok: false, status: 200, base, attempts, fid, username, message: `The session token belongs to fid ${fid}, not --fid ${expectedFid}.` };
    return { ok: true, status: 200, base, attempts, fid, username, text: last.text, message: `Token accepted by ${base}; it belongs to fid ${fid}${username ? ` (@${username})` : ''}${expectedFid !== undefined ? `, which matches --fid ${expectedFid}` : ''}.` };
  }

  // Cursor pagination: limit + cursor until next.cursor is absent. A 400 on the first page retries with
  // a smaller limit, then none (as quick-capture does). A repeated cursor is an error.
  async paginate(path: string, params: Record<string, string | number>, itemsKey: string, limit: number, o: { auth?: boolean } = {}): Promise<ClientPaged> {
    const out: ClientPaged = { status: 'error:not-started', base: this.base, pages: [], items: [], lastCursorEmpty: false };
    const limits = [limit, 15, undefined].filter((v, i, a) => a.indexOf(v) === i);
    let li = 0;
    let cursor: string | undefined;
    const seen = new Set<string>();
    while (!interrupt.requested) {
      const q: Record<string, string | number | undefined> = { ...params, limit: limits[li], cursor };
      const r = out.pages.length === 0 ? await this.getWithFallback(path, q, { auth: o.auth }) : await this.get(path, q, { auth: o.auth });
      out.base = this.base;
      if (r.status === 400 && out.pages.length === 0 && li < limits.length - 1) {
        li++;
        continue;
      }
      if (r.status !== 200) {
        out.status = r.status === 0 ? `error:network:${r.error}` : `unavailable:${r.status}`;
        out.errorBody = r.text.slice(0, 2000);
        return out;
      }
      out.pages.push(r.text);
      out.limitUsed = limits[li];
      let body: { result?: Record<string, unknown>; next?: { cursor?: string } };
      try {
        body = JSON.parse(r.text);
      } catch {
        out.status = 'error:non-json';
        return out;
      }
      const items = body.result?.[itemsKey];
      if (Array.isArray(items)) out.items.push(...items);
      else if (out.pages.length === 1) {
        out.status = `error:missing-${itemsKey}`;
        return out;
      }
      const next = body.next?.cursor;
      if (!next) {
        out.lastCursorEmpty = true;
        out.status = out.items.length ? 'complete' : 'empty';
        return out;
      }
      if (seen.has(next)) {
        out.status = 'error:cursor-loop';
        return out;
      }
      seen.add(next);
      cursor = next;
    }
    out.status = 'interrupted';
    return out;
  }

  // Pages of an endpoint whose answer shape is not documented (the own moderation record, the stayed
  // list), always with the token: limit + cursor while next.cursor is new, at most maxPages pages. An
  // answer without a result object stops with unavailable:no-result, so a refusal sent with HTTP 200 is
  // never taken for an empty list. Counting is the caller's.
  async pagesRaw(path: string, params: Record<string, string | number>, o: { limit?: number; maxPages: number }): Promise<RawPages> {
    const out: RawPages = { status: 'error:not-started', base: this.base, pages: [], bodies: [], lastCursorEmpty: false };
    const seen = new Set<string>();
    let after: string | undefined;
    while (!interrupt.requested) {
      const q = { ...params, limit: o.limit, cursor: after };
      const r = out.pages.length === 0 ? await this.getWithFallback(path, q, { auth: true }) : await this.get(path, q, { auth: true });
      out.base = this.base;
      if (r.status !== 200) {
        out.status = r.status === 0 ? `error:network:${r.error}` : `unavailable:${r.status}`;
        if (r.text) out.errorBody = r.text.slice(0, 2000);
        out.note = firstError(r.text);
        return out;
      }
      let body: { result?: unknown; next?: { cursor?: unknown } } | null = null;
      try {
        body = JSON.parse(r.text);
      } catch {}
      if (!body || typeof body !== 'object' || body.result === undefined || body.result === null) {
        out.status = body && typeof body === 'object' ? 'unavailable:no-result' : 'unavailable:non-json';
        out.errorBody = r.text.slice(0, 2000);
        out.note = firstError(r.text);
        return out;
      }
      out.pages.push(r.text);
      out.bodies.push(body);
      const c = body.next?.cursor;
      const next = typeof c === 'string' && c ? c : undefined;
      if (!next) {
        out.lastCursorEmpty = true;
        out.status = 'complete';
        return out;
      }
      if (seen.has(next)) {
        out.status = 'error:cursor-loop';
        return out;
      }
      if (out.pages.length >= o.maxPages) {
        out.status = 'complete';
        out.note = `stopped after ${out.pages.length} page${out.pages.length === 1 ? '' : 's'}; next.cursor not followed`;
        return out;
      }
      seen.add(next);
      after = next;
    }
    out.status = 'interrupted';
    return out;
  }

  // Single-object endpoint (profile, muted keywords, muted channels).
  async getObject(path: string, params: Record<string, string | number>, o: { auth?: boolean } = {}): Promise<{ status: string; base: string; text?: string; body?: unknown }> {
    const r = await this.getWithFallback(path, params, { auth: o.auth });
    if (r.status !== 200) return { status: r.status === 0 ? `error:network:${r.error}` : `unavailable:${r.status}`, base: this.base, text: r.text };
    try {
      return { status: 'complete', base: this.base, text: r.text, body: JSON.parse(r.text) };
    } catch {
      return { status: 'error:non-json', base: this.base, text: r.text };
    }
  }
}
