// Record/replay helpers for fixtures. Protocol calls are recorded at the transport interface as
// base64 protobuf; client API responses are recorded per path+query (host-independent).

import { Message, OnChainEvent, type OnChainEventType, SignersByFidResponse, StorageLimitsResponse, UserNameProof } from '@farcaster/core';
import type { EventPage, MessagePage, ProtocolTransport, ShardBlock, SignerPage, Store } from '../src/protocol/types.ts';
import { TransportError } from '../src/protocol/types.ts';
import { fromB64, toB64 } from '../src/util.ts';

type Calls = Record<string, unknown>;
const tok = (t?: Uint8Array) => (t && t.length ? toB64(t) : '');

const encMsgPage = (p: MessagePage) => ({ messages: p.messages.map((m) => toB64(Message.encode(m).finish())), nextPageToken: p.nextPageToken ? toB64(p.nextPageToken) : null });
const decMsgPage = (j: { messages: string[]; nextPageToken: string | null }): MessagePage => ({ messages: j.messages.map((b) => Message.decode(fromB64(b))), nextPageToken: j.nextPageToken ? fromB64(j.nextPageToken) : undefined });
const encEvtPage = (p: EventPage) => ({ events: p.events.map((e) => toB64(OnChainEvent.encode(e).finish())), nextPageToken: p.nextPageToken ? toB64(p.nextPageToken) : null });
const decEvtPage = (j: { events: string[]; nextPageToken: string | null }): EventPage => ({ events: j.events.map((b) => OnChainEvent.decode(fromB64(b))), nextPageToken: j.nextPageToken ? fromB64(j.nextPageToken) : undefined });
const encSignerPage = (p: SignerPage) => ({ response: toB64(SignersByFidResponse.encode(p.response).finish()), nextPageToken: p.nextPageToken ? toB64(p.nextPageToken) : null });
const decSignerPage = (j: { response: string; nextPageToken: string | null }): SignerPage => ({ response: SignersByFidResponse.decode(fromB64(j.response)), nextPageToken: j.nextPageToken ? fromB64(j.nextPageToken) : undefined });
const encBlocks = (bs: ShardBlock[]) => bs.map((b) => ({ ...b, hash: toB64(b.hash), messages: b.messages.map((m) => toB64(Message.encode(m).finish())) }));
const decBlocks = (j: { number: number; timestamp: number; hash: string; messages: string[] }[]): ShardBlock[] => j.map((b) => ({ ...b, hash: fromB64(b.hash), messages: b.messages.map((m) => Message.decode(fromB64(m))) }));

export class RecordingTransport implements ProtocolTransport {
  readonly label: string;
  readonly kind: 'grpc' | 'http';
  readonly calls: Calls = {};
  private readonly inner: ProtocolTransport;
  constructor(inner: ProtocolTransport) {
    this.inner = inner;
    this.label = inner.label;
    this.kind = inner.kind;
  }
  async allByFid(store: Store, fid: number, t?: Uint8Array) {
    const r = await this.inner.allByFid(store, fid, t);
    this.calls[`allByFid:${store}:${fid}:${tok(t)}`] = encMsgPage(r);
    return r;
  }
  async linksByTarget(fid: number, t?: Uint8Array) {
    const r = await this.inner.linksByTarget(fid, t);
    this.calls[`linksByTarget:${fid}:${tok(t)}`] = encMsgPage(r);
    return r;
  }
  async linkCompactState(fid: number) {
    const r = await this.inner.linkCompactState(fid);
    this.calls[`linkCompactState:${fid}`] = encMsgPage(r);
    return r;
  }
  async onChainEvents(fid: number, type: OnChainEventType, t?: Uint8Array) {
    const r = await this.inner.onChainEvents(fid, type, t);
    this.calls[`onChainEvents:${fid}:${type}:${tok(t)}`] = encEvtPage(r);
    return r;
  }
  async onChainSigners(fid: number, t?: Uint8Array) {
    const r = await this.inner.onChainSigners(fid, t);
    this.calls[`onChainSigners:${fid}:${tok(t)}`] = encEvtPage(r);
    return r;
  }
  async signersByFid(fid: number, t?: Uint8Array) {
    const r = await this.inner.signersByFid(fid, t);
    this.calls[`signersByFid:${fid}:${tok(t)}`] = encSignerPage(r);
    return r;
  }
  async shardZeroHeight() {
    const r = await this.inner.shardZeroHeight();
    this.calls.shardZeroHeight ??= r;
    return r;
  }
  async shardZeroBlocks(start: number, stop: number) {
    const r = await this.inner.shardZeroBlocks(start, stop);
    this.calls[`shardZeroBlocks:${start}:${stop}`] = encBlocks(r);
    return r;
  }
  async storageLimits(fid: number) {
    const r = await this.inner.storageLimits(fid);
    this.calls[`storageLimits:${fid}`] ??= toB64(StorageLimitsResponse.encode(r.value).finish());
    return r;
  }
  async usernameProofs(fid: number) {
    const r = await this.inner.usernameProofs(fid);
    this.calls[`usernameProofs:${fid}`] = r.proofs.map((p) => toB64(UserNameProof.encode(p).finish()));
    return r;
  }
  async castById(fid: number, hash: Uint8Array) {
    const r = await this.inner.castById(fid, hash);
    this.calls[`castById:${fid}:${toB64(hash)}`] = r ? toB64(Message.encode(r).finish()) : null;
    return r;
  }
  close() {
    this.inner.close();
  }
}

// Replays recorded calls. An unrecorded call is a test failure, reported as a non-retryable error.
export class ReplayTransport implements ProtocolTransport {
  readonly label: string;
  readonly kind = 'grpc' as const;
  private readonly calls: Calls;
  readonly misses: string[] = [];
  constructor(calls: Calls, label = 'grpc://fixture') {
    this.calls = calls;
    this.label = label;
  }
  private get(key: string): unknown {
    if (!(key in this.calls)) {
      this.misses.push(key);
      throw new TransportError(`fixture has no call ${key}`, { retryable: false, code: 'fixture_miss' });
    }
    return this.calls[key];
  }
  async allByFid(store: Store, fid: number, t?: Uint8Array) {
    return decMsgPage(this.get(`allByFid:${store}:${fid}:${tok(t)}`) as never);
  }
  async linksByTarget(fid: number, t?: Uint8Array) {
    return decMsgPage(this.get(`linksByTarget:${fid}:${tok(t)}`) as never);
  }
  async linkCompactState(fid: number) {
    return decMsgPage(this.get(`linkCompactState:${fid}`) as never);
  }
  async onChainEvents(fid: number, type: OnChainEventType, t?: Uint8Array) {
    return decEvtPage(this.get(`onChainEvents:${fid}:${type}:${tok(t)}`) as never);
  }
  async onChainSigners(fid: number, t?: Uint8Array) {
    return decEvtPage(this.get(`onChainSigners:${fid}:${tok(t)}`) as never);
  }
  async signersByFid(fid: number, t?: Uint8Array) {
    return decSignerPage(this.get(`signersByFid:${fid}:${tok(t)}`) as never);
  }
  async shardZeroHeight() {
    return this.get('shardZeroHeight') as number;
  }
  async shardZeroBlocks(start: number, stop: number) {
    return decBlocks(this.get(`shardZeroBlocks:${start}:${stop}`) as never);
  }
  async storageLimits(fid: number) {
    return { value: StorageLimitsResponse.decode(fromB64(this.get(`storageLimits:${fid}`) as string)) };
  }
  async usernameProofs(fid: number) {
    return { proofs: (this.get(`usernameProofs:${fid}`) as string[]).map((b) => UserNameProof.decode(fromB64(b))) };
  }
  async castById(fid: number, hash: Uint8Array) {
    const v = this.get(`castById:${fid}:${toB64(hash)}`) as string | null;
    return v ? Message.decode(fromB64(v)) : null;
  }
  close() {}
}

export const clientKey = (u: string | URL): string => {
  const url = new URL(u.toString());
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `${url.pathname.replace(/^\/~api/, '')}?${new URLSearchParams(params).toString()}`;
};

export type ClientStore = Record<string, { status: number; body: string }>;

export function recordingFetch(store: ClientStore, trim: (key: string, body: string) => string = (_k, b) => b): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fetch(input as string, init);
    const body = await res.text();
    const key = clientKey(input instanceof Request ? input.url : input);
    store[key] = { status: res.status, body: trim(key, body) };
    return new Response(store[key].body, { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

export interface SeenRequest {
  url: string;
  headers: Record<string, string>;
}

export function replayFetch(store: ClientStore, seen: SeenRequest[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const r = store[clientKey(url)];
    if (!r) return new Response('{"error":"not in fixture"}', { status: 404 });
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
