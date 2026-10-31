// Gasless signers (AC-04 (c)): a KEY_ADD signed by a test custody key, found by the exporter in a mock
// shard 0 and checked offline by verify. FID 11's recorded export is the base; the mock adds a custody
// transfer to the test key, messages signed by the gasless key, its signer record and the blocks. All keys
// are generated here from fixed strings and registered nowhere.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  CastType,
  FarcasterNetwork,
  IdRegisterEventType,
  makeCastAdd,
  makeKeyAdd,
  makeKeyAddBody,
  makeKeyRemove,
  makeKeyRemoveBody,
  makeReactionAdd,
  type Message,
  MessageType,
  NobleEd25519Signer,
  OnChainEvent,
  OnChainEventType,
  ReactionType,
  SignersByFidResponse,
  SignerSource,
  ViemLocalEip712Signer,
} from '@farcaster/core';
import { privateKeyToAccount } from 'viem/accounts';
import { type ExportOptions } from '../src/export.ts';
import { FARCASTER_EPOCH_S, type KeyEvent, walkGaslessKey } from '../src/gasless.ts';
import { type ShardBlock, type Store, unsupported } from '../src/protocol/types.ts';
import { fromHex } from '../src/util.ts';
import { verifyExport } from '../src/verify.ts';
import { fixture, replayExport } from './helpers.ts';
import { ReplayTransport } from './replay.ts';

const FID = 11;
const seed = (s: string) => createHash('sha256').update(s).digest();
const custodyKey = (name: string) => new ViemLocalEip712Signer(privateKeyToAccount(`0x${seed(name).toString('hex')}`));
const CUSTODY = custodyKey('castsnap test custody key');
const OTHER_CUSTODY = custodyKey('castsnap test other custody key');
const CUSTODY_ADDRESS = fromHex(privateKeyToAccount(`0x${seed('castsnap test custody key').toString('hex')}`).address);
const GASLESS = new NobleEd25519Signer(new Uint8Array(seed('castsnap test gasless signer')));
const ALL_SCOPES = [MessageType.CAST_ADD, MessageType.CAST_REMOVE, MessageType.REACTION_ADD, MessageType.REACTION_REMOVE, MessageType.LINK_ADD, MessageType.LINK_REMOVE];
const DAY = 86_400;

// Farcaster seconds. Shard-0 block h has timestamp BASE + h; a message merges 2 blocks after it was made.
const T1 = (Date.UTC(2026, 5, 1) - Date.UTC(2021, 0, 1)) / 1000;
// makeKeyAddBody refuses a deadline before now (Farcaster time); AC-04 does not use it.
const DEADLINE = (Date.UTC(2036, 0, 1) - Date.UTC(2021, 0, 1)) / 1000;
const BASE = T1 - 100_000;
const HEIGHT = 300_000;
const blockOf = (ts: number) => ts - BASE + 2;

const unwrap = <T>(r: { isErr(): boolean; value?: T; error?: unknown }): T => {
  if (r.isErr()) throw r.error;
  return r.value as T;
};

interface Scenario {
  transferAt?: number; // custody transfer to CUSTODY, Farcaster seconds
  adds: { at: number; nonce: number; signer?: ViemLocalEip712Signer; scopes?: MessageType[]; ttl?: number }[];
  removes?: { at: number; nonce: number }[];
  listedAt?: number; // the signer record's addedAt; default: the last add
  casts: number[];
  reactions?: number[];
  noBlocks?: boolean;
}

async function build(s: Scenario) {
  const key = unwrap<Uint8Array>(await GASLESS.getSignerKey());
  const data = (timestamp: number) => ({ fid: FID, network: FarcasterNetwork.MAINNET, timestamp });
  const keyMsgs: Message[] = [];
  for (const a of s.adds) {
    const body = unwrap(await makeKeyAddBody({ fid: BigInt(FID), key, scopes: a.scopes ?? ALL_SCOPES, ttl: a.ttl ?? 90 * DAY, nonce: a.nonce, deadline: DEADLINE }, a.signer ?? CUSTODY));
    keyMsgs.push(unwrap(await makeKeyAdd(body, data(a.at), GASLESS)));
  }
  for (const r of s.removes ?? []) {
    const body = unwrap(await makeKeyRemoveBody({ fid: BigInt(FID), key, nonce: r.nonce, deadline: DEADLINE }, CUSTODY));
    keyMsgs.push(unwrap(await makeKeyRemove(body, data(r.at), GASLESS)));
  }
  const casts: Message[] = [];
  for (const [i, at] of s.casts.entries()) {
    casts.push(unwrap(await makeCastAdd({ text: `gasless cast ${i}`, embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], type: CastType.CAST }, data(at), GASLESS)));
  }
  // Reactions target the first gasless cast, an own cast, so the export looks up no context cast.
  const reactions: Message[] = [];
  for (const at of s.reactions ?? []) {
    reactions.push(unwrap(await makeReactionAdd({ type: ReactionType.LIKE, targetCastId: { fid: FID, hash: casts[0].hash } }, data(at), GASLESS)));
  }
  const byBlock = new Map<number, Message[]>();
  for (const m of keyMsgs) byBlock.set(blockOf(m.data!.timestamp), [...(byBlock.get(blockOf(m.data!.timestamp)) ?? []), m]);
  const listedAt = s.listedAt ?? Math.max(...s.adds.map((a) => a.at));
  const last = s.adds.find((a) => a.at === listedAt) ?? s.adds.at(-1)!;
  const listed = SignersByFidResponse.fromPartial({
    signers: [{ source: SignerSource.OFFCHAIN, key, keyType: 1, fid: FID, addedAt: listedAt + FARCASTER_EPOCH_S, ttl: last.ttl ?? 90 * DAY, scopes: last.scopes ?? ALL_SCOPES, requestFid: FID, nonce: last.nonce }],
  }).signers;
  const transfer = OnChainEvent.fromPartial({
    type: OnChainEventType.EVENT_TYPE_ID_REGISTER,
    chainId: 10,
    blockNumber: 999_999_999,
    blockHash: new Uint8Array(32),
    blockTimestamp: (s.transferAt ?? T1 - 30 * DAY) + FARCASTER_EPOCH_S,
    transactionHash: new Uint8Array(32),
    logIndex: 0,
    fid: FID,
    idRegisterEventBody: { to: CUSTODY_ADDRESS, eventType: IdRegisterEventType.TRANSFER, from: new Uint8Array(20), recoveryAddress: new Uint8Array(20) },
  });
  return { key, casts, reactions, byBlock, listed, transfer };
}

class GaslessProtocol extends ReplayTransport {
  readonly blockRequests: [number, number][] = [];
  private readonly g: Awaited<ReturnType<typeof build>>;
  private readonly noBlocks: boolean;
  constructor(g: Awaited<ReturnType<typeof build>>, noBlocks = false) {
    super(fixture('fid11-protocol.json'));
    this.g = g;
    this.noBlocks = noBlocks;
  }
  async allByFid(store: Store, fid: number, t?: Uint8Array) {
    const p = await super.allByFid(store, fid, t);
    const extra = store === 'casts' ? this.g.casts : store === 'reactions' ? this.g.reactions : [];
    return t?.length ? p : { ...p, messages: [...p.messages, ...extra] };
  }
  async onChainEvents(fid: number, type: OnChainEventType, t?: Uint8Array) {
    const p = await super.onChainEvents(fid, type, t);
    return type === OnChainEventType.EVENT_TYPE_ID_REGISTER && !t?.length ? { ...p, events: [...p.events, this.g.transfer] } : p;
  }
  async signersByFid(fid: number, t?: Uint8Array) {
    const p = await super.signersByFid(fid, t);
    return { ...p, response: { ...p.response, signers: [...p.response.signers, ...this.g.listed] } };
  }
  async shardZeroHeight() {
    if (this.noBlocks) throw unsupported(this.label, 'shard-0 blocks');
    return HEIGHT;
  }
  async shardZeroBlocks(start: number, stop: number) {
    this.blockRequests.push([start, stop]);
    const out: ShardBlock[] = [];
    for (let h = start; h < Math.min(stop, HEIGHT); h++) out.push({ number: h, timestamp: BASE + h, hash: new Uint8Array(32), messages: this.g.byBlock.get(h) ?? [] });
    return out;
  }
}

async function run(s: Scenario, over: Partial<ExportOptions> = {}) {
  const g = await build(s);
  const transport = new GaslessProtocol(g, s.noBlocks);
  const r = await replayExport({ transport, ...over });
  const v = await verifyExport(r.dir);
  const check = (id: string) => v.checks.find((c) => c.id === id)!;
  return { r, v, ac04: check('AC-04'), ac01: check('AC-01'), source: r.manifest.sources['protocol:key-messages'], transport };
}

test('a valid gasless KEY_ADD is exported and authorizes the messages its key signed (AC-04 PASS)', async () => {
  const { r, ac04, ac01, source } = await run({ adds: [{ at: T1, nonce: 1 }], casts: [T1 + 60, T1 + 120], reactions: [T1 + 180] });
  assert.equal(source.status, 'complete', JSON.stringify(source));
  assert.equal(source.items, 1);
  assert.deepEqual(source.files, ['raw/protocol/key-messages.pb', 'raw/protocol/key-messages.jsonl', 'raw/protocol/key-message-blocks.jsonl']);
  assert.equal(r.manifest.sources['protocol:signers-by-fid'].status, 'complete');
  assert.ok(r.manifest.datasets.D7.sources.includes('protocol:key-messages'));
  assert.equal(ac01.verdict, 'PASS', ac01.detail.join(' | '));
  assert.equal(ac04.verdict, 'PASS', ac04.detail.join(' | '));
  assert.match(ac04.detail.join('\n'), /by a gasless KEY_ADD 3; not authorized 0/);
  assert.match(ac04.detail.join('\n'), /KEY_ADD 1, valid 1/);
  assert.match(ac04.detail.join('\n'), /key-messages 1\/1/);
  assert.match(ac04.detail.join('\n'), /gasless keys with an exported KEY_ADD 1\/1/);
});

test('a KEY_ADD whose custody signature is from the wrong key authorizes nothing', async () => {
  const { ac04, source } = await run({ adds: [{ at: T1, nonce: 1, signer: OTHER_CUSTODY }], casts: [T1 + 60] });
  assert.equal(source.status, 'complete');
  assert.equal(ac04.verdict, 'FAIL');
  const d = ac04.detail.join('\n');
  assert.match(d, /KEY_ADD 1, valid 0/);
  assert.match(d, /custody signature does not recover to the custody address at its time \(1\)/);
  assert.match(d, /not authorized: casts CAST_ADD 0x[0-9a-f]+ signer 0x[0-9a-f]{12} at .*: no valid exported KEY_ADD/);
});

test('the custody address is the one at the KEY_ADD\'s time: a transfer to the signing key after it does not count', async () => {
  const { ac04 } = await run({ transferAt: T1 + 30, adds: [{ at: T1, nonce: 1 }], casts: [T1 + 60] });
  assert.equal(ac04.verdict, 'FAIL');
  assert.match(ac04.detail.join('\n'), /custody signature does not recover/);
});

test('a message type outside the KEY_ADD scopes is not authorized', async () => {
  const { ac04 } = await run({ adds: [{ at: T1, nonce: 1, scopes: [MessageType.CAST_ADD] }], casts: [T1 + 60], reactions: [T1 + 120] });
  assert.equal(ac04.verdict, 'FAIL');
  const d = ac04.detail.join('\n');
  assert.match(d, /by a gasless KEY_ADD 1; not authorized 1/);
  assert.match(d, /not authorized: reactions REACTION_ADD .*: its message type is not in the KEY_ADD scopes/);
});

test('a message later than the last use + TTL is not authorized', async () => {
  // TTL 1 h: the cast at +600 s moves the last use there, so +4,000 s is still in and moves it again;
  // +7,601 s is one second past 4,000 + 3,600.
  const { ac04 } = await run({ adds: [{ at: T1, nonce: 1, ttl: 3600 }], casts: [T1 + 600, T1 + 4000, T1 + 7601] });
  assert.equal(ac04.verdict, 'FAIL');
  const d = ac04.detail.join('\n');
  assert.match(d, /by a gasless KEY_ADD 2; not authorized 1/);
  assert.match(d, /: later than the key's last use \+ TTL/);
});

test('a renewed key: the exporter also finds the KEY_ADD before the earliest message', async () => {
  const { ac04, source, transport } = await run({ adds: [{ at: T1, nonce: 1 }, { at: T1 + 10_000, nonce: 2 }], casts: [T1 + 60, T1 + 10_060] });
  assert.equal(source.status, 'complete', JSON.stringify(source));
  assert.equal(source.items, 2);
  assert.equal(ac04.verdict, 'PASS', ac04.detail.join(' | '));
  assert.match(ac04.detail.join('\n'), /KEY_ADD 2, valid 2/);
  // Found near each target, not by scanning the whole chain.
  const scanned = transport.blockRequests.filter(([a, b]) => b - a > 1).reduce((n, [a, b]) => n + b - a, 0);
  assert.ok(scanned < 1000, `scanned ${scanned} blocks`);
});

test('a KEY_ADD outside the scanned blocks is reported as not found, and AC-04 fails', async () => {
  const { ac04, ac01, source } = await run({ adds: [{ at: T1 - 40_000, nonce: 1 }, { at: T1 + 10_000, nonce: 2 }], casts: [T1, T1 + 10_060] });
  assert.equal(source.status, 'unavailable:1-key-adds-not-found-in-scanned-blocks');
  assert.match(source.notes!.join('\n'), /not found: a KEY_ADD at or before the earliest own message of key 0x[0-9a-f]{12}/);
  assert.equal(ac01.verdict, 'PASS', ac01.detail.join(' | '));
  assert.equal(ac04.verdict, 'FAIL');
  assert.match(ac04.detail.join('\n'), /by a gasless KEY_ADD 1; not authorized 1/);
});

test('a KEY_REMOVE ends the key: a later message is not authorized', async () => {
  // The remove sits in the 100-block chunk scanned for the KEY_ADD: removes are only captured that way.
  const { ac04, source } = await run({ adds: [{ at: T1, nonce: 1 }], removes: [{ at: T1 + 20, nonce: 2 }], casts: [T1 + 10, T1 + 40] });
  assert.equal(source.items, 2);
  assert.equal(ac04.verdict, 'FAIL');
  assert.match(ac04.detail.join('\n'), /KEY_REMOVE 1/);
  assert.match(ac04.detail.join('\n'), /its key was removed by a KEY_REMOVE before it/);
});

test('with no transport that serves blocks, the key messages are unavailable, not an error', async () => {
  const { ac04, ac01, source } = await run({ adds: [{ at: T1, nonce: 1 }], casts: [T1 + 60], noBlocks: true });
  assert.equal(source.status, 'unavailable:no-transport-endpoint');
  assert.equal(ac01.verdict, 'PASS', ac01.detail.join(' | '));
  assert.equal(ac04.verdict, 'FAIL');
});

test('sliding TTL: a use more than 300 s after the last use moves it; a closer one does not', () => {
  const add: KeyEvent<string> = { kind: 'add', ts: 0, scopes: [MessageType.CAST_ADD], ttl: 1000 };
  const use = (ref: string, ts: number): KeyEvent<string> => ({ kind: 'use', ts, type: MessageType.CAST_ADD, ref });
  // 400 moves the last use to 400, so 1,300 is within 400 + 1,000; 1,300 then moves it, so 2,250 is in.
  assert.deepEqual([...walkGaslessKey([add, use('a', 400), use('b', 1300), use('c', 2250)])], [['a', 'authorized'], ['b', 'authorized'], ['c', 'authorized']]);
  // 250 is within the 300 s throttle and does not move the last use, so 1,100 is past 0 + 1,000.
  assert.deepEqual([...walkGaslessKey([add, use('a', 250), use('b', 1100)])], [['a', 'authorized'], ['b', 'expired']]);
  // The boundary is inclusive: last use + TTL itself is still in.
  assert.deepEqual([...walkGaslessKey([add, use('a', 1000)])], [['a', 'authorized']]);
  // A KEY_REMOVE ends the key until the next KEY_ADD, which starts a new window.
  assert.deepEqual([...walkGaslessKey([add, { kind: 'remove', ts: 100 }, use('a', 200), { ...add, ts: 300 }, use('b', 400)])], [['a', 'removed'], ['b', 'authorized']]);
  // Order is by timestamp, not input order; at equal timestamps a KEY_ADD comes first.
  assert.deepEqual([...walkGaslessKey([use('a', 0), add])], [['a', 'authorized']]);
});
