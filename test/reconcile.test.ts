import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followersTolerance, type ProtoEdge, reconcile } from '../src/reconcile.ts';

const edges = (...fids: number[]) => new Map<number, ProtoEdge>(fids.map((fid) => [fid, { fid, hash: `0x${fid}`, since: '2024-01-01T00:00:00.000Z' }]));
const users = (...fids: number[]) => fids.map((fid) => ({ fid }));

test('following: self-follow, hidden_by_client, count check against the profile', () => {
  const r = reconcile({
    fid: 7,
    following: { protocol: edges(7, 1, 2, 3), client: users(1, 2), profileCount: 3 },
    followers: { protocol: edges(4, 5), client: users(4, 6), profileCount: 2 },
    blocks: { protocol: edges(), client: users(9) },
    profile: { protocol: { username: 'a', displayName: 'A', bio: '', pfpUrl: '', url: '' }, client: { username: 'a', displayName: 'B', bio: '', pfpUrl: '', url: '' } },
  });
  const f = r.entries.filter((e) => e.dataset === 'following');
  assert.deepEqual(f.map((e) => [e.fid, e.reason]), [[7, 'self_follow'], [3, 'hidden_by_client']]);
  assert.equal(r.summary.following.protocolExcludingSelf, 3);
  assert.equal(r.summary.following.countMatchesProfile, true);
  assert.deepEqual(r.entries.filter((e) => e.dataset === 'followers').map((e) => [e.fid, e.reason]), [[5, 'hidden_by_client'], [6, 'client_only']]);
  assert.deepEqual(r.entries.filter((e) => e.dataset === 'blocks').map((e) => [e.fid, e.reason]), [[9, 'client_only']]);
  assert.deepEqual(r.entries.filter((e) => e.dataset === 'profile').map((e) => [e.field, e.reason]), [['displayName', 'profile_field_mismatch']]);
  for (const e of r.entries) assert.ok(r.reasonCodes.includes(e.reason));
});

test('following count mismatch is recorded', () => {
  const r = reconcile({
    fid: 7,
    following: { protocol: edges(1, 2), client: users(1, 2), profileCount: 5 },
    followers: { protocol: edges(), client: [], profileCount: 0 },
    blocks: { protocol: edges(), client: [] },
    profile: { protocol: {}, client: null },
  });
  assert.equal(r.entries.filter((e) => e.reason === 'count_mismatch').length, 1);
  assert.equal(r.summary.following.countMatchesProfile, false);
});

test('AC-11 tolerance is max(2, 0.5% of the client list)', () => {
  assert.equal(followersTolerance(82), 2);
  assert.equal(followersTolerance(400), 2);
  assert.equal(followersTolerance(4000), 20);
});
