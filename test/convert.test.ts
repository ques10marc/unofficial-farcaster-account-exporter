// HTTP JSON -> protobuf conversion must be byte-exact, or HTTP-fallback exports would fail AC-04.
// Fixture: the same FID 13 verifications and FID 4 ID-register event from both APIs (recorded).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { Message, OnChainEvent, validations } from '@farcaster/core';
import { eventFromHttpJson, messageFromHttpJson } from '../src/protocol/http.ts';
import { fromB64, toHex } from '../src/util.ts';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/http-vs-grpc.json', import.meta.url), 'utf8'));

test('verifications (Solana base58 and contract-wallet "type") convert to the exact gRPC bytes', async () => {
  const http = JSON.parse(fx.verificationsFid13.http).messages as Record<string, unknown>[];
  const grpc = (fx.verificationsFid13.grpc as string[]).map((b) => Message.decode(fromB64(b)));
  assert.ok(http.length >= 3);
  const protocols = new Set(http.map((m) => (m.data as { verificationAddAddressBody?: { protocol?: string } }).verificationAddAddressBody?.protocol));
  assert.ok(protocols.has('PROTOCOL_SOLANA') && protocols.has('PROTOCOL_ETHEREUM'));
  const byHash = new Map(grpc.map((m) => [toHex(m.hash), m]));
  for (const j of http) {
    const m = messageFromHttpJson(j);
    const g = byHash.get(String(j.hash));
    assert.ok(g, `gRPC has ${j.hash}`);
    assert.deepEqual(Buffer.from(m.dataBytes!), Buffer.from(g.dataBytes!), `dataBytes for ${j.hash}`);
    const h = await validations.createMessageHash(m.dataBytes!, 1);
    assert.equal(toHex(h._unsafeUnwrap()), j.hash);
  }
});

test('ID-register events with Rust-style enum names convert', () => {
  const http = JSON.parse(fx.idRegisterFid4.http).events as Record<string, unknown>[];
  const grpc = (fx.idRegisterFid4.grpc as string[]).map((b) => OnChainEvent.decode(fromB64(b)));
  assert.equal((http[0].idRegisterEventBody as { eventType: string }).eventType, 'Register');
  const e = eventFromHttpJson(http[0]);
  assert.equal(e.idRegisterEventBody?.eventType, grpc[0].idRegisterEventBody?.eventType);
  assert.equal(toHex(e.transactionHash), toHex(grpc[0].transactionHash));
  assert.equal(toHex(e.idRegisterEventBody?.to), toHex(grpc[0].idRegisterEventBody?.to));
});
