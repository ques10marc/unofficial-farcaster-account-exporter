// gRPC transport (canonical). GetAll*MessagesByFid returns adds AND removes, so exported counts can
// equal storageLimitsByFid.used exactly (AC-13), and messages keep their signed dataBytes (AC-04).
//
// Uses the raw HubServiceClient rather than hub-nodejs's promisified wrapper: the wrapper's close() does
// not call close, and its errors drop the gRPC status code that retry decisions need.

import { getSSLClient, Metadata, type HubServiceClient } from '@farcaster/hub-nodejs';
import type { GetInfoResponse, Message, OnChainEventType, SignersByFidResponse, StorageLimitsResponse, UsernameProofsResponse } from '@farcaster/core';
import { USER_AGENT } from '../util.ts';
import { type EventPage, type MessagePage, type ProtocolTransport, type ShardBlock, type SignerPage, type Store, TransportError } from './types.ts';

const PAGE_SIZE = 1000; // per shard, as seen on snap.farcaster.xyz
const DEADLINE_MS = 120_000;
// The node streams about 45 shard-0 blocks per second; a 100-block request takes a few seconds.
const BLOCKS_DEADLINE_MS = 300_000;

// gRPC status codes worth retrying: UNKNOWN, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, ABORTED, INTERNAL, UNAVAILABLE.
const RETRYABLE = new Set([2, 4, 8, 10, 13, 14]);
const NOT_FOUND = 5;

interface ServiceErrorLike {
  code?: number;
  details?: string;
  message?: string;
}

// Only the fields of the hub's Block that the exporter reads.
interface BlockLike {
  header?: { height?: { blockNumber?: number }; timestamp?: number };
  hash: Uint8Array;
  transactions: { userMessages: Message[] }[];
}

const STORE_METHOD: Record<Store, string> = {
  casts: 'getAllCastMessagesByFid',
  reactions: 'getAllReactionMessagesByFid',
  links: 'getAllLinkMessagesByFid',
  userData: 'getAllUserDataMessagesByFid',
  verifications: 'getAllVerificationMessagesByFid',
  storageLends: 'getAllLendStorageMessagesByFid',
};

export class GrpcTransport implements ProtocolTransport {
  readonly label: string;
  readonly kind = 'grpc' as const;
  private readonly client: HubServiceClient;

  // makeClient is replaceable only so a test can reach a local plaintext server.
  constructor(address: string, makeClient: typeof getSSLClient = getSSLClient) {
    this.label = `grpc://${address}`;
    this.client = makeClient(address, { 'grpc.primary_user_agent': USER_AGENT });
  }

  private call<T>(method: string, request: object): Promise<T> {
    return new Promise((resolve, reject) => {
      const fn = (this.client as unknown as Record<string, Function>)[method];
      if (typeof fn !== 'function') {
        reject(new TransportError(`gRPC method ${method} not available`, { retryable: false, code: 'unsupported' }));
        return;
      }
      fn.call(this.client, request, new Metadata(), { deadline: Date.now() + DEADLINE_MS }, (e: ServiceErrorLike | null, res: T) => {
        if (!e) return resolve(res);
        reject(this.error(method, e));
      });
    });
  }

  private error(method: string, e: ServiceErrorLike): TransportError {
    const code = typeof e.code === 'number' ? e.code : -1;
    const detail = e.details || e.message || 'unknown error';
    const notFound = code === NOT_FOUND || /not\s*found/i.test(detail);
    return new TransportError(`${this.label} ${method}: ${detail} (grpc status ${code})`, {
      retryable: !notFound && RETRYABLE.has(code),
      code: notFound ? 'not_found' : `grpc_${code}`,
    });
  }

  private async messages(method: string, request: object): Promise<MessagePage> {
    const r = await this.call<{ messages: Message[]; nextPageToken?: Uint8Array }>(method, request);
    return { messages: r.messages, nextPageToken: r.nextPageToken };
  }

  allByFid(store: Store, fid: number, pageToken?: Uint8Array): Promise<MessagePage> {
    return this.messages(STORE_METHOD[store], { fid, pageSize: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) });
  }

  linksByTarget(fid: number, pageToken?: Uint8Array): Promise<MessagePage> {
    return this.messages('getLinksByTarget', { targetFid: fid, linkType: 'follow', pageSize: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) });
  }

  linkCompactState(fid: number): Promise<MessagePage> {
    return this.messages('getLinkCompactStateMessageByFid', { fid });
  }

  async onChainEvents(fid: number, type: OnChainEventType, pageToken?: Uint8Array): Promise<EventPage> {
    const r = await this.call<EventPage>('getOnChainEvents', { fid, eventType: type, pageSize: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) });
    return { events: r.events, nextPageToken: r.nextPageToken };
  }

  async onChainSigners(fid: number, pageToken?: Uint8Array): Promise<EventPage> {
    const r = await this.call<EventPage>('getOnChainSignersByFid', { fid, pageSize: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) });
    return { events: r.events, nextPageToken: r.nextPageToken };
  }

  // requesterFids must be present: the request does not serialize without it.
  async signersByFid(fid: number, pageToken?: Uint8Array): Promise<SignerPage> {
    const r = await this.call<SignersByFidResponse>('getSignersByFid', { fid, pageSize: PAGE_SIZE, requesterFids: [], ...(pageToken ? { pageToken } : {}) });
    return { response: r, nextPageToken: r.nextPageToken };
  }

  async shardZeroHeight(): Promise<number> {
    const r = await this.call<GetInfoResponse>('getInfo', {});
    const s = r.shardInfos.find((x) => x.shardId === 0);
    if (!s) throw new TransportError(`${this.label} getInfo: no shard 0 in the response`, { retryable: false, code: 'no_shard_0' });
    return Number(s.maxHeight);
  }

  shardZeroBlocks(start: number, stop: number): Promise<ShardBlock[]> {
    return new Promise((resolve, reject) => {
      const out: ShardBlock[] = [];
      const s = this.client.getBlocks({ startBlockNumber: start, stopBlockNumber: stop }, new Metadata(), { deadline: Date.now() + BLOCKS_DEADLINE_MS });
      s.on('data', (b: BlockLike) =>
        out.push({ number: Number(b.header?.height?.blockNumber ?? 0), timestamp: Number(b.header?.timestamp ?? 0), hash: b.hash, messages: b.transactions.flatMap((t) => t.userMessages) }),
      );
      s.on('error', (e: ServiceErrorLike) => reject(this.error('getBlocks', e)));
      s.on('end', () => resolve(out));
    });
  }

  async storageLimits(fid: number) {
    return { value: await this.call<StorageLimitsResponse>('getCurrentStorageLimitsByFid', { fid }) };
  }

  async usernameProofs(fid: number) {
    const r = await this.call<UsernameProofsResponse>('getUserNameProofsByFid', { fid });
    return { proofs: r.proofs };
  }

  async castById(fid: number, hash: Uint8Array): Promise<Message | null> {
    try {
      return await this.call<Message>('getCast', { fid, hash });
    } catch (e) {
      if (e instanceof TransportError && e.code === 'not_found') return null;
      throw e;
    }
  }

  close(): void {
    this.client.close();
  }
}
