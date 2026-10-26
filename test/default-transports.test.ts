// Protocol fallback stays on Farcaster's own Snapchain nodes, so one export never mixes two networks.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultTransports } from '../src/export.ts';
import { type ProtocolTransport, TransportError } from '../src/protocol/types.ts';
import { replayExport } from './helpers.ts';

const labels = (hub?: string) => {
  const ts = defaultTransports(hub);
  for (const t of ts) t.close();
  return ts.map((t) => t.label);
};

test('default order: snap gRPC, crackle gRPC, snap HTTP, crackle HTTP; never haatz', () => {
  assert.deepEqual(labels(), ['grpc://snap.farcaster.xyz:3383', 'grpc://crackle.farcaster.xyz:3383', 'https://snap.farcaster.xyz:3381', 'https://crackle.farcaster.xyz:3381']);
});

test('a --hub naming one of those nodes is tried first, then the rest, without duplicates', () => {
  assert.deepEqual(labels('crackle.farcaster.xyz:3383'), ['grpc://crackle.farcaster.xyz:3383', 'grpc://snap.farcaster.xyz:3383', 'https://snap.farcaster.xyz:3381', 'https://crackle.farcaster.xyz:3381']);
  assert.deepEqual(labels('https://snap.farcaster.xyz:3381/'), ['https://snap.farcaster.xyz:3381', 'grpc://snap.farcaster.xyz:3383', 'grpc://crackle.farcaster.xyz:3383', 'https://crackle.farcaster.xyz:3381']);
});

test('any other --hub gets no fallback', () => {
  assert.deepEqual(labels('https://haatz.quilibrium.com'), ['https://haatz.quilibrium.com']);
  assert.deepEqual(labels('node.example:3383'), ['grpc://node.example:3383']);
});

test('when every protocol node fails, the run says so and exits 1', async () => {
  const unreachable = (label: string) =>
    new Proxy({ label, kind: 'grpc', close: () => {} }, {
      get: (t, k) =>
        k in t
          ? t[k as keyof typeof t]
          : async () => {
              throw new TransportError(`${label}: unreachable`, { retryable: true, code: 'network' });
            },
    }) as unknown as ProtocolTransport;
  const r = await replayExport({ transports: [unreachable('grpc://a.example:3383'), unreachable('https://b.example:3381')] });
  assert.equal(r.exitCode, 1);
  const line = r.logs.find((l) => l.startsWith('Protocol data: every node failed (grpc://a.example:3383, https://b.example:3381).'));
  assert.ok(line, r.logs.join('\n'));
  assert.match(line, /only web traffic \(port 443\)/);
});
