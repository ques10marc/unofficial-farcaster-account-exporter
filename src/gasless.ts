// Gasless signers (AC-04 (c)). Since Snapchain engine V16 an Ed25519 key can be authorized by a KEY_ADD
// message (type 16) that the FID's custody address signs (EIP-712), with scopes and a sliding TTL, instead
// of an on-chain KeyRegistry event; KEY_REMOVE (type 17) ends it. Both are merged on shard 0 and no node
// API returns them, so the exporter finds them in shard-0 blocks, and verify replays them offline.
//
// Rules from Snapchain v0.14.3 (fc87f26): scopes are enforced per message type (active_key.rs); a key is
// expired when last use + ttl < the block's timestamp; a KEY_ADD sets the last use to its own timestamp,
// and a later message moves it only when more than 300 s later (key_last_used_at_store.rs).

import { Message, MessageData, MessageType } from '@farcaster/core';
import type { ShardBlock } from './protocol/types.ts';
import { FARCASTER_EPOCH_MS, fcTimeToIso, toHex } from './util.ts';

export const FARCASTER_EPOCH_S = FARCASTER_EPOCH_MS / 1000;
export const SLIDING_TTL_THROTTLE_SECONDS = 300;

export const messageData = (m: Message): MessageData | undefined => m.data ?? (m.dataBytes?.length ? MessageData.decode(m.dataBytes) : undefined);
export const isKeyMessage = (d: MessageData | undefined): boolean => d?.type === MessageType.KEY_ADD || d?.type === MessageType.KEY_REMOVE;
// The key a KEY_ADD adds or a KEY_REMOVE removes (0x-hex).
export const keyOf = (d: MessageData): string => toHex(d.keyAddBody?.key ?? d.keyRemoveBody?.key);
export const shortKey = (k: string): string => k.slice(0, 14);

// ---------- exporter: finding KEY_ADD and KEY_REMOVE messages in shard-0 blocks ----------

export interface BlockSource {
  height(): Promise<number>;
  blocks(start: number, stop: number): Promise<ShardBlock[]>;
}

export interface FoundKeyMessage {
  message: Message;
  data: MessageData;
  block: number;
  blockTimestamp: number;
  blockHash: Uint8Array;
}

// latest: a listed gasless key's latest KEY_ADD, whose timestamp the signer record gives (addedAt).
// before: the latest KEY_ADD at or before a key's earliest own message, for a key whose signer record
// is newer than that message (renewed) or that is not listed at all (removed).
export interface KeyTarget {
  key: string;
  kind: 'latest' | 'before';
  at: number; // Farcaster seconds
}

// Shard 0 makes about one block per second and the public node streams about 45 per second, so these
// windows cost about 1 minute ('latest') and 8 minutes ('before') when nothing is found.
export const SEARCH_LIMITS = { chunk: 100, latestBefore: 600, latestAfter: 1800, lookback: 21_600 };

export class KeyMessageSearch {
  readonly found = new Map<string, FoundKeyMessage>();
  lookups = 0;
  blocksScanned = 0;
  private readonly scanned = new Set<number>();
  private readonly stamps = new Map<number, number | null>();
  private top = 0;
  private readonly src: BlockSource;
  private readonly fid: number;
  private readonly limits: typeof SEARCH_LIMITS;
  private readonly log: (s: string) => void;
  private readonly isInterrupted: () => boolean;

  constructor(src: BlockSource, fid: number, o: { limits?: typeof SEARCH_LIMITS; log?: (s: string) => void; isInterrupted?: () => boolean } = {}) {
    this.src = src;
    this.fid = fid;
    this.limits = o.limits ?? SEARCH_LIMITS;
    this.log = o.log ?? (() => {});
    this.isInterrupted = o.isInterrupted ?? (() => false);
  }

  satisfied(t: KeyTarget): boolean {
    for (const f of this.found.values()) {
      if (f.data.type !== MessageType.KEY_ADD || keyOf(f.data) !== t.key) continue;
      if (t.kind === 'latest' ? f.data.timestamp === t.at : f.data.timestamp <= t.at) return true;
    }
    return false;
  }

  // Searches the blocks around the target's time; returns whether it was found.
  async find(t: KeyTarget): Promise<boolean> {
    if (this.satisfied(t)) return true;
    const h = await this.heightAt(t.at);
    const done = () => this.satisfied(t);
    if (t.kind === 'latest') {
      await this.scan(h - 30, h + this.limits.latestAfter, done);
      await this.scan(h - 30, h - this.limits.latestBefore, done);
    } else {
      await this.scan(h + 30, h - this.limits.lookback, done);
    }
    const ok = done();
    this.log(`    key messages: ${t.kind === 'latest' ? 'latest KEY_ADD' : 'KEY_ADD before the earliest message'} of key ${shortKey(t.key)} (${fcTimeToIso(t.at)}): ${ok ? 'found' : 'NOT found'}; blocks scanned so far ${this.blocksScanned}`);
    return ok;
  }

  // Scanned block ranges, merged, for the manifest.
  ranges(): string[] {
    const c = this.limits.chunk;
    const ks = [...this.scanned].sort((a, b) => a - b);
    const out: string[] = [];
    for (let i = 0; i < ks.length; ) {
      let j = i;
      while (j + 1 < ks.length && ks[j + 1] === ks[j] + 1) j++;
      out.push(`${Math.max(1, ks[i] * c)}-${Math.min(this.top, (ks[j] + 1) * c - 1)}`);
      i = j + 1;
    }
    return out;
  }

  private async timestampAt(h: number): Promise<number | null> {
    if (!this.stamps.has(h)) {
      this.lookups++;
      const [b] = await this.src.blocks(h, h + 1);
      this.stamps.set(h, b ? b.timestamp : null);
    }
    return this.stamps.get(h)!;
  }

  // Lowest height whose header timestamp reaches t. Heights the node does not serve count as earlier.
  private async heightAt(t: number): Promise<number> {
    if (!this.top) this.top = (await this.src.height()) - 1;
    let lo = 0;
    let hi = this.top;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const ts = await this.timestampAt(mid);
      if (ts === null || ts < t) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  // Scans whole chunks from the one holding `from` toward the one holding `to`, skipping chunks already
  // scanned, until done() holds.
  private async scan(from: number, to: number, done: () => boolean): Promise<void> {
    const c = this.limits.chunk;
    const chunkOf = (h: number) => Math.min(Math.floor(this.top / c), Math.max(0, Math.floor(h / c)));
    const first = chunkOf(from);
    const last = chunkOf(to);
    const step = first <= last ? 1 : -1;
    for (let k = first; step > 0 ? k <= last : k >= last; k += step) {
      if (done() || this.isInterrupted()) return;
      if (this.scanned.has(k)) continue;
      const blocks = await this.src.blocks(Math.max(1, k * c), Math.min(this.top + 1, (k + 1) * c));
      this.scanned.add(k);
      this.blocksScanned += blocks.length;
      for (const b of blocks) {
        for (const m of b.messages) {
          const d = messageData(m);
          if (d?.fid !== this.fid || !isKeyMessage(d)) continue;
          this.found.set(toHex(m.hash), { message: m, data: d, block: b.number, blockTimestamp: b.timestamp, blockHash: b.hash });
        }
      }
      if (this.blocksScanned % 5000 < blocks.length) this.log(`    key messages: ${this.blocksScanned} shard-0 blocks scanned`);
    }
  }
}

// ---------- verify: the sliding-TTL walk of one gasless key ----------

export type KeyUse = 'authorized' | 'no-key-add' | 'removed' | 'out-of-scope' | 'expired';

export type KeyEvent<T> =
  | { kind: 'add'; ts: number; scopes: number[]; ttl: number }
  | { kind: 'remove'; ts: number }
  | { kind: 'use'; ts: number; type: number; ref: T };

// Replays one key's valid KEY_ADDs, its KEY_REMOVEs and the messages it signed in timestamp order, with
// message timestamps in place of the block timestamps an export does not hold. At equal timestamps a
// KEY_ADD comes first and a KEY_REMOVE last. A message that is not authorized does not move the last use.
export function walkGaslessKey<T>(events: KeyEvent<T>[]): Map<T, KeyUse> {
  const rank = { add: 0, use: 1, remove: 2 };
  const sorted = [...events].sort((a, b) => a.ts - b.ts || rank[a.kind] - rank[b.kind]);
  const out = new Map<T, KeyUse>();
  let active: { lastUse: number; scopes: Set<number>; ttl: number } | null = null;
  let removed = false;
  for (const e of sorted) {
    if (e.kind === 'add') {
      active = { lastUse: e.ts, scopes: new Set(e.scopes), ttl: e.ttl };
      removed = false;
    } else if (e.kind === 'remove') {
      active = null;
      removed = true;
    } else if (!active) out.set(e.ref, removed ? 'removed' : 'no-key-add');
    else if (!active.scopes.has(e.type)) out.set(e.ref, 'out-of-scope');
    else if (e.ts > active.lastUse + active.ttl) out.set(e.ref, 'expired');
    else {
      out.set(e.ref, 'authorized');
      if (e.ts > active.lastUse + SLIDING_TTL_THROTTLE_SECONDS) active.lastUse = e.ts;
    }
  }
  return out;
}
