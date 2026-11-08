// Local mock of the Farcaster client API (127.0.0.1 only) for the private adapter's tests. It implements
// the private endpoints castsnap uses (paths and result keys from types.yml), cursor pagination with
// next.cursor, 401 for a missing or wrong token, 400 for a limit above an endpoint's maximum, 429 with
// Retry-After, and two "hosts" as path prefixes (/primary and /~api) so the host fallback can be tested.
// Public endpoints are served from the recorded FID 11 fixture.
//
// Every request is recorded (path, query, whether it carried a token and whether it was the right one),
// so tests can prove where the token went.
//
// Standalone: MOCK_TOKEN=<token> node test/mock-server.ts [--reject-primary]  prints MOCK_URL=... and runs
// until killed (for running the CLI by hand against the mock).

import http from 'node:http';
import { fixture } from './helpers.ts';
import { buildPrivateFixture, type PrivateFixture } from './private-fixtures.ts';
import { type ClientStore, clientKey } from './replay.ts';

type Obj = Record<string, unknown>;

export interface MockRequest {
  prefix: string;
  path: string;
  query: Record<string, string>;
  auth: 'none' | 'valid' | 'invalid';
  status: number;
}

export interface MockOptions {
  token: string;
  data?: PrivateFixture;
  publicStore?: ClientStore;
  // Prefixes ("primary", "~api") whose private endpoints reject every token with this status.
  rejectPrefixes?: Record<string, number>;
  // 401 bodies echo the Authorization header the server received (a careless server).
  echoToken?: boolean;
  // Paths answered once with 429 (Retry-After: 1) before succeeding.
  once429?: string[];
  // Paths whose next.cursor never changes (a broken server), to exercise the loop guard.
  loopCursor?: string[];
  // Private paths that refuse even the right token with this status (an endpoint the account cannot use).
  rejectPaths?: Record<string, number>;
  // Paths (public or private) whose first N responses send the headers and half the body, then drop the
  // connection: a network that fails mid-response. Infinity drops every response.
  dropBody?: Record<string, number>;
  // The own moderation record and the stayed list, whose real shapes are unknown: each answer's status
  // (default 200) and body, page by page. The mock adds next.cursor to every 200 page but the last.
  // Unset: 404, as an app without the endpoint would answer.
  ownRecord?: { status?: number; body: unknown }[];
  stayed?: { status?: number; body: unknown };
}

const PRIVATE_PATHS = new Set(['/v2/me', '/v2/bookmarked-casts', '/v2/direct-cast-conversation-list', '/v2/direct-cast-conversation-messages', '/v2/draft-casts', '/v2/get-muted-keywords', '/v2/get-muted-users', '/v2/get-muted-channels', '/v1/favorite-frames', '/v2/network-code/public-rap-sheet', '/v2/opt-in/following-stayed']);

// Maximum page sizes: types.yml declares 100 for bookmarks; 50 is what quick-capture used for the others.
// Muted users take at most 15 here so the "400 on the first page, retry with a smaller limit" path runs.
const MAX: Record<string, number> = { '/v2/bookmarked-casts': 100, '/v2/direct-cast-conversation-list': 50, '/v2/direct-cast-conversation-messages': 50, '/v2/draft-casts': 50, '/v2/get-muted-users': 15, '/v1/favorite-frames': 50 };
const DEFAULT: Record<string, number> = { '/v2/bookmarked-casts': 20 };

const encCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
const decCursor = (c: string): number | null => {
  try {
    const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')).o;
    return Number.isInteger(o) && o >= 0 ? o : null;
  } catch {
    return null;
  }
};

export async function startMock(opts: MockOptions): Promise<{ url: string; requests: MockRequest[]; data: PrivateFixture; close: () => Promise<void> }> {
  const data = opts.data ?? buildPrivateFixture();
  const store = opts.publicStore ?? (fixture('fid11-client.json') as ClientStore);
  const requests: MockRequest[] = [];
  const served429 = new Set<string>();
  const dropped = new Map<string, number>();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const seg = u.pathname.split('/')[1] ?? '';
    const prefix = seg === 'primary' || seg === '~api' ? seg : '';
    const path = prefix ? u.pathname.slice(prefix.length + 1) : u.pathname;
    const query = Object.fromEntries(u.searchParams.entries());
    const header = req.headers.authorization;
    const auth: MockRequest['auth'] = header === undefined ? 'none' : header === `Bearer ${opts.token}` ? 'valid' : 'invalid';
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      requests.push({ prefix, path, query, auth, status });
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      const n = dropped.get(path) ?? 0;
      if (n < (opts.dropBody?.[path] ?? 0)) {
        dropped.set(path, n + 1);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers });
        res.write(text.slice(0, Math.floor(text.length / 2)), () => res.destroy());
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(text);
    };
    if (req.method !== 'GET') return send(405, { errors: [{ message: 'GET only' }] });

    if (!PRIVATE_PATHS.has(path)) {
      const r = store[clientKey(`http://x${path}${u.search}`)];
      return r ? send(r.status, r.body) : send(404, { errors: [{ message: 'not in fixture' }] });
    }

    const reject = opts.rejectPrefixes?.[prefix] ?? (auth === 'valid' ? opts.rejectPaths?.[path] : undefined);
    if (auth !== 'valid' || reject) {
      const status = reject ?? 401;
      return send(status, { errors: [{ message: opts.echoToken ? `Unauthorized: received ${header ?? 'nothing'}` : 'Unauthorized' }] });
    }
    if (opts.once429?.includes(path) && !served429.has(path)) {
      served429.add(path);
      return send(429, { errors: [{ message: 'slow down' }] }, { 'retry-after': '1' });
    }

    if (path === '/v2/network-code/public-rap-sheet' || path === '/v2/opt-in/following-stayed') {
      const answers = path === '/v2/opt-in/following-stayed' ? (opts.stayed ? [opts.stayed] : []) : (opts.ownRecord ?? []);
      const i = query.cursor === undefined ? 0 : decCursor(query.cursor);
      const a = i === null ? undefined : answers[i];
      if (i === null || !a) return send(404, { errors: [{ message: 'not found' }] });
      const status = a.status ?? 200;
      const more = status === 200 && i + 1 < answers.length && a.body !== null && typeof a.body === 'object';
      return send(status, more ? { ...(a.body as Obj), next: { cursor: encCursor(i + 1) } } : a.body);
    }
    if (path === '/v2/me') return send(200, data.me);
    if (path === '/v2/get-muted-keywords') return send(200, { success: true, result: data.mutedKeywords });
    if (path === '/v2/get-muted-channels') return send(200, { success: true, result: { mutedChannels: data.mutedChannels } });

    let items: Obj[];
    let key: string;
    let extra: Obj = {};
    if (path === '/v2/bookmarked-casts') [items, key] = [data.bookmarks, 'bookmarks'];
    else if (path === '/v2/direct-cast-conversation-list') {
      const cat = (query.category ?? 'default') as keyof PrivateFixture['conversations'];
      if (!(cat in data.conversations)) return send(400, { errors: [{ message: 'bad category' }] });
      [items, key] = [data.conversations[cat], 'conversations'];
      extra = { hasArchived: data.conversations.archived.length > 0, requestsCount: data.conversations.request.length, voidCount: data.conversations.void.length };
    } else if (path === '/v2/direct-cast-conversation-messages') {
      const m = data.messages[query.conversationId ?? ''];
      if (!m) return send(400, { errors: [{ message: 'unknown conversation' }] });
      [items, key] = [m, 'messages'];
    } else if (path === '/v2/draft-casts') [items, key] = [data.drafts, 'drafts'];
    else if (path === '/v2/get-muted-users') [items, key] = [data.mutedUsers, 'mutedUsers'];
    else [items, key] = [data.frames, 'frames'];

    const limit = query.limit === undefined ? (DEFAULT[path] ?? 15) : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > (MAX[path] ?? 50)) return send(400, { errors: [{ message: `limit must be 1..${MAX[path] ?? 50}` }] });
    const offset = query.cursor === undefined ? 0 : decCursor(query.cursor);
    if (offset === null) return send(400, { errors: [{ message: 'bad cursor' }] });
    const page = items.slice(offset, offset + limit);
    const more = offset + limit < items.length;
    const next = opts.loopCursor?.includes(path) ? { cursor: encCursor(0) } : more ? { cursor: encCursor(offset + limit) } : undefined;
    return send(200, { result: { ...extra, [key]: page }, ...(next ? { next } : {}) });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    data,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

if (import.meta.main) {
  const token = process.env.MOCK_TOKEN;
  if (!token) {
    console.error('set MOCK_TOKEN to the token the mock should accept');
    process.exit(64);
  }
  const m = await startMock({ token, rejectPrefixes: process.argv.includes('--reject-primary') ? { primary: 401 } : undefined });
  console.log(`MOCK_URL=${m.url}`);
}
