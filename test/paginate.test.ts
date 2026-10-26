import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectPages, isAllNullShardToken, PaginationError, withRetry } from '../src/protocol/paginate.ts';
import { TransportError } from '../src/protocol/types.ts';

const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));

test('all-null shard tokens are recognised, real shard tokens are not', () => {
  assert.equal(isAllNullShardToken(bytes('[null,null]')), true);
  assert.equal(isAllNullShardToken(bytes('[null]')), true);
  assert.equal(isAllNullShardToken(bytes('[null, null, null]')), true);
  // Real token from snap.farcaster.xyz (prefix): a shard cursor, not an end marker.
  assert.equal(isAllNullShardToken(bytes('[[6,0,0,0,11,6,120,140,165,108],null]')), false);
  assert.equal(isAllNullShardToken(bytes('')), false);
});

test('pagination ends on an empty token', async () => {
  const pages = [
    { items: [1, 2], nextPageToken: bytes('a') },
    { items: [3], nextPageToken: new Uint8Array() },
  ];
  let i = 0;
  const r = await collectPages(async () => pages[i++]);
  assert.deepEqual(r.items, [1, 2, 3]);
  assert.equal(r.pages, 2);
  assert.equal(r.end, 'empty-token');
});

test('cross-shard pagination ends on base64("[null,null]") instead of looping', async () => {
  // HTTP gives the token as base64 'W251bGwsbnVsbF0='; transports hand it over as bytes.
  const end = new Uint8Array(Buffer.from('W251bGwsbnVsbF0=', 'base64'));
  let calls = 0;
  const r = await collectPages(async () => {
    calls++;
    return { items: ['x'], nextPageToken: end };
  });
  assert.equal(calls, 1);
  assert.equal(r.end, 'all-null-shard-token');
});

test('a repeated token is an error, never a loop', async () => {
  const fetches: (string | undefined)[] = [];
  await assert.rejects(
    collectPages(async (t) => {
      fetches.push(t && Buffer.from(t).toString());
      return { items: [1], nextPageToken: bytes('same') };
    }),
    (e: unknown) => e instanceof PaginationError && /repeated page token/.test(e.message),
  );
  assert.deepEqual(fetches, [undefined, 'same']);
});

test('retryable errors are retried with backoff; others are not', async () => {
  const waits: number[] = [];
  let n = 0;
  const v = await withRetry(
    async () => {
      if (++n < 3) throw new TransportError('unavailable', { retryable: true, code: 'grpc_14' });
      return 'ok';
    },
    { wait: async (ms) => void waits.push(ms) },
  );
  assert.equal(v, 'ok');
  assert.deepEqual(waits, [1000, 2000]);
  let m = 0;
  await assert.rejects(withRetry(async () => {
    m++;
    throw new TransportError('bad', { retryable: false, code: 'grpc_3' });
  }));
  assert.equal(m, 1);
});
