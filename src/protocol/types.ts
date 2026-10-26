// Protocol transport interface. Implementations: gRPC (canonical) and the Snapchain HTTP API
// (fallback). Page tokens are bytes on both; the HTTP transport converts base64 at its edge.

import type { Message, OnChainEvent, OnChainEventType, SignersByFidResponse, StorageLimitsResponse, UserNameProof } from '@farcaster/core';

export type Store = 'casts' | 'reactions' | 'links' | 'userData' | 'verifications' | 'storageLends';
export const STORES: Store[] = ['casts', 'reactions', 'links', 'userData', 'verifications', 'storageLends'];
// storageLimitsByFid store names, for the AC-13 comparison.
export const STORE_LIMIT_NAME: Record<Store, string> = {
  casts: 'CASTS',
  reactions: 'REACTIONS',
  links: 'LINKS',
  userData: 'USER_DATA',
  verifications: 'VERIFICATIONS',
  storageLends: 'STORAGE_LENDS',
};

// raw: the verbatim response body, when the transport has one (HTTP). gRPC responses are decoded by
// the client library, so their raw tier is the re-encoded protobuf of each message.
export interface MessagePage {
  messages: Message[];
  nextPageToken?: Uint8Array;
  raw?: string;
}
export interface EventPage {
  events: OnChainEvent[];
  nextPageToken?: Uint8Array;
  raw?: string;
}
// One GetSignersByFid page, kept whole: besides the signers it carries the node's gasless key count and
// the FID's current user nonce.
export interface SignerPage {
  response: SignersByFidResponse;
  nextPageToken?: Uint8Array;
  raw?: string;
}
// A shard-0 block, reduced to what the exporter keeps. timestamp is the header's, in Farcaster seconds.
export interface ShardBlock {
  number: number;
  timestamp: number;
  hash: Uint8Array;
  messages: Message[];
}

export interface ProtocolTransport {
  readonly label: string; // e.g. grpc://snap.farcaster.xyz:3383
  readonly kind: 'grpc' | 'http';
  allByFid(store: Store, fid: number, pageToken?: Uint8Array): Promise<MessagePage>;
  linksByTarget(fid: number, pageToken?: Uint8Array): Promise<MessagePage>;
  linkCompactState(fid: number): Promise<MessagePage>;
  onChainEvents(fid: number, type: OnChainEventType, pageToken?: Uint8Array): Promise<EventPage>;
  onChainSigners(fid: number, pageToken?: Uint8Array): Promise<EventPage>;
  // Unified signer list: active on-chain keys plus every gasless (KEY_ADD) key the node holds, expired
  // ones included. On-chain keys that were removed are not listed.
  signersByFid(fid: number, pageToken?: Uint8Array): Promise<SignerPage>;
  // Shard-0 blocks, where KEY_ADD and KEY_REMOVE messages are merged; no other API returns those.
  // gRPC only. stop is exclusive.
  shardZeroHeight(): Promise<number>;
  shardZeroBlocks(start: number, stop: number): Promise<ShardBlock[]>;
  storageLimits(fid: number): Promise<{ value: StorageLimitsResponse; raw?: string }>;
  usernameProofs(fid: number): Promise<{ proofs: UserNameProof[]; raw?: string }>;
  // Resolves null when the node reports the cast as not found (deleted or pruned).
  castById(fid: number, hash: Uint8Array): Promise<Message | null>;
  close(): void;
}

// retryable: worth retrying on the same host. unsupported: this transport has no such endpoint.
export class TransportError extends Error {
  readonly retryable: boolean;
  readonly code: string;
  constructor(message: string, opts: { retryable: boolean; code: string }) {
    super(message);
    this.name = 'TransportError';
    this.retryable = opts.retryable;
    this.code = opts.code;
  }
}

export const unsupported = (label: string, what: string): TransportError =>
  new TransportError(`${label} has no endpoint for ${what}`, { retryable: false, code: 'unsupported' });
