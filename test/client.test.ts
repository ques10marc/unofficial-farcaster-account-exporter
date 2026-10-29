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

// A 200 whose body fails partway through, as when the connection drops after the headers arrive.
const brokenBody = (err: Error) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"result":'));
        c.error(err);
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
const timeoutError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

test('a body that fails mid-read is retried like a failed connection, and the retry is logged', async () => {
  const waits: number[] = [];
  const logs: string[] = [];
  const responses = [brokenBody(timeoutError()), json({ result: { users: [{ fid: 1 }] } })];
  const api = new ClientApi({ fetchImpl: (async () => responses.shift()!) as typeof fetch, limiter: noLimit(), wait: async (ms) => void waits.push(ms), log: (s) => logs.push(s) });
  const r = await api.paginate('/v2/followers', { fid: 1 }, 'users', 50);
  assert.equal(r.status, 'complete');
  assert.equal(r.items.length, 1);
  assert.deepEqual(waits, [2000]);
  assert.deepEqual(logs, ['    network error, retry 1 in 2s: The operation was aborted due to timeout']);
});

test('a body that keeps failing gives up after 10 attempts with status 0, without throwing', async () => {
  let calls = 0;
  const waits: number[] = [];
  const api = new ClientApi({ fetchImpl: (async () => (calls++, brokenBody(timeoutError()))) as typeof fetch, limiter: noLimit(), wait: async (ms) => void waits.push(ms) });
  const r = await api.get('/v2/followers', { fid: 1 });
  assert.equal(r.status, 0);
  assert.equal(r.error, 'The operation was aborted due to timeout');
  assert.equal(calls, 10);
  assert.deepEqual(waits, [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000]);
  const p = await api.paginate('/v2/followers', { fid: 1 }, 'users', 50);
  assert.equal(p.status, 'error:network:The operation was aborted due to timeout');
});

test('after one request uses up its network retries, later requests try once each', async () => {
  let calls = 0;
  const waits: number[] = [];
  const logs: string[] = [];
  const api = new ClientApi({ fetchImpl: (async () => (calls++, brokenBody(timeoutError()))) as typeof fetch, limiter: noLimit(), wait: async (ms) => void waits.push(ms), log: (s) => logs.push(s) });
  assert.equal((await api.get('/v2/followers', { fid: 1 })).status, 0);
  assert.equal(calls, 10);
  for (const path of ['/v2/following', '/v2/channels']) {
    const r = await api.get(path, { fid: 1 });
    assert.equal(r.status, 0);
    assert.equal(r.error, 'The operation was aborted due to timeout');
  }
  assert.equal(calls, 12, 'one call each once the network is down');
  assert.equal(waits.length, 9, 'no waits once the network is down');
  assert.deepEqual(logs.filter((l) => l.includes('network still failing')), ['    network still failing after 10 attempts; later requests try once each until one gets through']);
});

test('once any response gets through, requests get their full network retries again', async () => {
  let calls = 0;
  let up = false;
  const waits: number[] = [];
  const logs: string[] = [];
  const fetchImpl = (async () => (calls++, up ? json({ errors: [] }, 404) : brokenBody(timeoutError()))) as typeof fetch;
  const api = new ClientApi({ fetchImpl, limiter: noLimit(), wait: async (ms) => void waits.push(ms), log: (s) => logs.push(s) });
  await api.get('/v2/followers', { fid: 1 }); // uses up its 10 attempts
  up = true;
  // A 404 is still a response: the network is back.
  assert.equal((await api.get('/v2/following', { fid: 1 })).status, 404);
  assert.ok(logs.includes('    network back: requests get full retries again'), logs.join('\n'));
  up = false;
  calls = 0;
  waits.length = 0;
  assert.equal((await api.get('/v2/channels', { fid: 1 })).status, 0);
  assert.equal(calls, 10);
  assert.deepEqual(waits, [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000]);
});
