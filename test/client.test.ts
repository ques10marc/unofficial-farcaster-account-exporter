import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClientApi } from '../src/client.ts';
import { RateLimiter } from '../src/util.ts';

const noLimit = () => new RateLimiter({ windows: [] });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

test('429 is honoured: Retry-After when given, else exponential backoff from 30 s', async () => {
  const waits: number[] = [];
  const responses = [json({}, 429, { 'retry-after': '7' }), json({}, 429), json({}, 429), json({ result: { users: [{ fid: 1 }] } })];
  const api = new ClientApi({ fetchImpl: (async () => responses.shift()!) as typeof fetch, limiter: noLimit(), wait: async (ms) => void waits.push(ms) });
  const r = await api.paginate('/v2/followers', { fid: 1 }, 'users', 50);
  assert.equal(r.status, 'complete');
  assert.deepEqual(waits, [7000, 30_000, 60_000]);
});

test('cursor pagination follows next.cursor to the end and records an empty last cursor', async () => {
  const seen: string[] = [];
  const pages: Record<string, unknown> = {
    '': { result: { users: [{ fid: 1 }, { fid: 2 }] }, next: { cursor: 'c1' } },
    c1: { result: { users: [{ fid: 3 }] } },
  };
  const api = new ClientApi({
    fetchImpl: (async (u: URL) => {
      seen.push(u.toString());
      return json(pages[u.searchParams.get('cursor') ?? '']);
    }) as typeof fetch,
    limiter: noLimit(),
  });
  const r = await api.paginate('/v2/following', { fid: 9 }, 'users', 50);
  assert.equal(r.items.length, 3);
  assert.equal(r.lastCursorEmpty, true);
  assert.equal(r.pages.length, 2);
  assert.match(seen[0], /limit=50/);
  assert.doesNotMatch(seen[0], /cursor=/);
});

test('a repeated cursor is an error', async () => {
  const api = new ClientApi({ fetchImpl: (async () => json({ result: { users: [{ fid: 1 }] }, next: { cursor: 'x' } })) as typeof fetch, limiter: noLimit() });
  const r = await api.paginate('/v2/following', { fid: 9 }, 'users', 50);
  assert.equal(r.status, 'error:cursor-loop');
  assert.equal(r.lastCursorEmpty, false);
});

test('host fallback: 5xx on the primary host switches to the web proxy host for the run', async () => {
  const hosts: string[] = [];
  const api = new ClientApi({
    fetchImpl: (async (u: URL) => {
      hosts.push(u.host + u.pathname);
      return u.host === 'client.farcaster.xyz' ? json({}, 503) : json({ result: { user: { fid: 5 } } });
    }) as typeof fetch,
    limiter: noLimit(),
    wait: async () => {},
  });
  const r = await api.getObject('/v2/user-by-fid', { fid: 5 });
  assert.equal(r.status, 'complete');
  assert.equal(api.currentBase, 'https://farcaster.xyz/~api');
  assert.equal(hosts.at(-1), 'farcaster.xyz/~api/v2/user-by-fid');
});

test('no request ever carries an Authorization header', async () => {
  const headers: Headers[] = [];
  const api = new ClientApi({
    fetchImpl: (async (_u: URL, init: RequestInit) => {
      headers.push(new Headers(init.headers));
      return json({ result: { channels: [] } });
    }) as typeof fetch,
    limiter: noLimit(),
  });
  await api.paginate('/v1/user-following-channels', { fid: 1 }, 'channels', 50);
  assert.ok(headers.length > 0);
  for (const h of headers) assert.equal(h.get('authorization'), null);
});

test('rate limiter enforces 20 per 10 s and 500 per hour', async () => {
  let now = 0;
  const waits: number[] = [];
  const lim = new RateLimiter({
    windows: [{ max: 20, ms: 10_000 }, { max: 500, ms: 3_600_000 }],
    now: () => now,
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  for (let i = 0; i < 20; i++) await lim.take();
  assert.equal(waits.length, 0);
  await lim.take(); // 21st within 10 s must wait for the first to leave the window
  assert.equal(waits.length, 1);
  assert.ok(now >= 10_000);
  for (let i = 0; i < 479; i++) await lim.take();
  const before = now;
  await lim.take(); // 501st within the hour
  assert.ok(now - before > 0 && now >= 3_600_000, `hour window not enforced: now=${now}`);
});
