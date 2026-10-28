// Snapchain HTTP API transport (fallback): https://snap.farcaster.xyz:3381, then https://crackle.farcaster.xyz:3381.
// The HTTP API omits reaction and link removes, so AC-13 cannot pass on data from it; the exporter
// records that as unavailable:http-omits-removes. Messages are converted to protobuf so the same
// offline verification runs on them; dataBytes is rebuilt from the JSON 'data' (compared with gRPC:
// byte-exact except for the Solana base58 fields, which this converter decodes).

import {
  base58ToBytes,
  Message,
  MessageData,
  messageTypeFromJSON,
  OnChainEvent,
  OnChainEventType,
  SignersByFidResponse,
  StorageLimitsResponse,
  UserNameProof,
  onChainEventTypeToJSON,
} from '@farcaster/core';
import { errMessage, fromB64, fromHex, toB64, toHex, USER_AGENT } from '../util.ts';
import { isAllNullShardToken } from './paginate.ts';
import { type EventPage, type MessagePage, type ProtocolTransport, type ShardBlock, type SignerPage, type Store, TransportError, unsupported } from './types.ts';

const PAGE_SIZE = 1000;
const TIMEOUT_MS = 120_000;

// Keys whose values are protobuf bytes rendered as 0x-hex by the HTTP API. Keyed by name so string
// fields that merely look like hex (cast text, userData values such as primary addresses) are untouched.
const HEX_BYTES_KEYS = new Set(['hash', 'targetHash', 'signer', 'address', 'blockHash', 'transactionHash', 'key', 'owner', 'to', 'from', 'recoveryAddress', 'payer', 'custodyAddress']);
const SOLANA_B58_KEYS = new Set(['address', 'blockHash']);

const isHex = (v: string) => /^0x[0-9a-fA-F]*$/.test(v);

// HTTP JSON -> ts-proto JSON (base64 for every bytes field).
export function toProtoJson(v: unknown, key = '', solana = false): unknown {
  if (Array.isArray(v)) return v.map((x) => toProtoJson(x, key, solana));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const sol = solana || o.protocol === 'PROTOCOL_SOLANA';
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, toProtoJson(x, k, sol)]));
  }
  if (typeof v === 'string' && HEX_BYTES_KEYS.has(key)) {
    if (isHex(v)) return toB64(fromHex(v));
    if (solana && SOLANA_B58_KEYS.has(key)) {
      const b = base58ToBytes(v);
      if (b.isOk()) return toB64(b.value);
    }
  }
  return v;
}

export function messageFromHttpJson(m: Record<string, unknown>): Message {
  const json = toProtoJson(m.data, 'data') as Record<string, unknown>;
  // The HTTP API names VerificationAddAddressBody.verification_type "type".
  const v = json?.verificationAddAddressBody as Record<string, unknown> | undefined;
  if (v && 'type' in v && !('verificationType' in v)) {
    const { type, ...rest } = v;
    json.verificationAddAddressBody = { ...rest, verificationType: type };
  }
  const data = MessageData.fromJSON(json);
  const dataBytes = MessageData.encode(data).finish();
  return Message.fromJSON({
    ...(toProtoJson({ hash: m.hash, signer: m.signer }) as object),
    data: MessageData.toJSON(data),
    dataBytes: toB64(dataBytes),
    hashScheme: m.hashScheme,
    signature: m.signature,
    signatureScheme: m.signatureScheme,
  });
}

// The HTTP API renders some enums by their Rust names ("Register", "ChangeRecovery") rather than the
// protobuf JSON names ts-proto expects ("ID_REGISTER_EVENT_TYPE_REGISTER").
const upperSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
export function eventFromHttpJson(e: Record<string, unknown>): OnChainEvent {
  const j = toProtoJson(e) as Record<string, unknown>;
  const idr = j.idRegisterEventBody as Record<string, unknown> | undefined;
  if (idr && typeof idr.eventType === 'string' && !idr.eventType.startsWith('ID_REGISTER_EVENT_TYPE_')) {
    j.idRegisterEventBody = { ...idr, eventType: `ID_REGISTER_EVENT_TYPE_${upperSnake(idr.eventType)}` };
  }
  return OnChainEvent.fromJSON(j);
}

// /v1/signersByFid names the on-chain event "onChainEvent" (protobuf: onchainEvent) and renders scopes,
// a repeated int32 of message types, by their enum names.
export function signersFromHttpJson(body: Record<string, unknown>): SignersByFidResponse {
  const signers = ((body.signers as Record<string, unknown>[]) ?? []).map((s) => {
    const { onChainEvent, scopes, ...rest } = s;
    return {
      ...(toProtoJson(rest) as object),
      scopes: ((scopes as unknown[]) ?? []).map((t) => (typeof t === 'number' ? t : messageTypeFromJSON(t))),
      ...(onChainEvent ? { onchainEvent: OnChainEvent.toJSON(eventFromHttpJson(onChainEvent as Record<string, unknown>)) } : {}),
    };
  });
  return SignersByFidResponse.fromJSON({ ...body, signers, nextPageToken: undefined });
}

const STORE_PATHS: Partial<Record<Store, { path: string; params?: Record<string, string>[] }>> = {
  casts: { path: 'castsByFid' },
  // reactionsByFid needs a type; both are fetched and merged.
  reactions: { path: 'reactionsByFid', params: [{ reaction_type: 'Like' }, { reaction_type: 'Recast' }] },
  links: { path: 'linksByFid' },
  userData: { path: 'userDataByFid' },
  verifications: { path: 'verificationsByFid' },
};

export class HttpTransport implements ProtocolTransport {
  readonly label: string;
  readonly kind = 'http' as const;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(base: string, fetchImpl: typeof fetch = fetch) {
    this.base = base.replace(/\/+$/, '');
    this.label = this.base;
    this.fetchImpl = fetchImpl;
  }

  private async get(path: string, params: Record<string, string | number | undefined>): Promise<{ body: Record<string, unknown>; raw: string }> {
    const url = new URL(`${this.base}/v1/${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new TransportError(`${this.label} ${path}: ${errMessage(e)}`, { retryable: true, code: 'network' });
    }
    const raw = await res.text();
    if (res.status !== 200) {
      const notFound = res.status === 404 || /NotFound|not found/i.test(raw);
      throw new TransportError(`${this.label} ${path}: HTTP ${res.status} ${raw.slice(0, 200)}`, {
        retryable: res.status === 429 || res.status >= 500,
        code: notFound ? 'not_found' : `http_${res.status}`,
      });
    }
    try {
      return { body: JSON.parse(raw), raw };
    } catch {
      throw new TransportError(`${this.label} ${path}: non-JSON response`, { retryable: true, code: 'non_json' });
    }
  }

  private async messagePage(path: string, params: Record<string, string | number | undefined>, pageToken?: Uint8Array): Promise<MessagePage> {
    const { body, raw } = await this.get(path, { ...params, pageSize: PAGE_SIZE, pageToken: pageToken ? toB64(pageToken) : undefined });
    const messages = ((body.messages as Record<string, unknown>[]) ?? []).map(messageFromHttpJson);
    const next = typeof body.nextPageToken === 'string' && body.nextPageToken ? fromB64(body.nextPageToken) : undefined;
    return { messages, nextPageToken: next, raw };
  }

  // Multi-request stores (reactions: Like + Recast) are paginated per sub-request. The page token
  // carries which sub-request it belongs to: 1 byte index + the node's own token.
  async allByFid(store: Store, fid: number, pageToken?: Uint8Array): Promise<MessagePage> {
    const spec = STORE_PATHS[store];
    if (!spec) throw unsupported(this.label, `store ${store}`);
    const subs = spec.params ?? [{}];
    let idx = 0;
    let inner: Uint8Array | undefined;
    if (pageToken && pageToken.length) {
      idx = pageToken[0];
      inner = pageToken.length > 1 ? pageToken.subarray(1) : undefined;
    }
    const page = await this.messagePage(spec.path, { fid, ...subs[idx] }, inner);
    const innerNext = page.nextPageToken;
    let next: Uint8Array | undefined;
    if (innerNext && innerNext.length && !isAllNullShardToken(innerNext)) next = Uint8Array.from([idx, ...innerNext]);
    else if (idx + 1 < subs.length) next = Uint8Array.from([idx + 1]);
    return { ...page, nextPageToken: next };
  }

  linksByTarget(fid: number, pageToken?: Uint8Array): Promise<MessagePage> {
    return this.messagePage('linksByTargetFid', { target_fid: fid, link_type: 'follow' }, pageToken);
  }

  async linkCompactState(): Promise<MessagePage> {
    throw unsupported(this.label, 'link compact state');
  }

  private async eventPage(path: string, params: Record<string, string | number | undefined>, pageToken?: Uint8Array): Promise<EventPage> {
    const { body, raw } = await this.get(path, { ...params, pageSize: PAGE_SIZE, pageToken: pageToken ? toB64(pageToken) : undefined });
    const events = ((body.events as Record<string, unknown>[]) ?? []).map(eventFromHttpJson);
    const next = typeof body.nextPageToken === 'string' && body.nextPageToken ? fromB64(body.nextPageToken) : undefined;
    return { events, nextPageToken: next, raw };
  }

  onChainEvents(fid: number, type: OnChainEventType, pageToken?: Uint8Array): Promise<EventPage> {
    return this.eventPage('onChainEventsByFid', { fid, event_type: onChainEventTypeToJSON(type) }, pageToken);
  }

  onChainSigners(fid: number, pageToken?: Uint8Array): Promise<EventPage> {
    return this.eventPage('onChainSignersByFid', { fid }, pageToken);
  }

  async signersByFid(fid: number, pageToken?: Uint8Array): Promise<SignerPage> {
    const { body, raw } = await this.get('signersByFid', { fid, pageSize: PAGE_SIZE, pageToken: pageToken ? toB64(pageToken) : undefined });
    const next = typeof body.nextPageToken === 'string' && body.nextPageToken ? fromB64(body.nextPageToken) : undefined;
    return { response: signersFromHttpJson(body), nextPageToken: next, raw };
  }

  async shardZeroHeight(): Promise<number> {
    throw unsupported(this.label, 'shard-0 blocks');
  }

  async shardZeroBlocks(): Promise<ShardBlock[]> {
    throw unsupported(this.label, 'shard-0 blocks');
  }

  async storageLimits(fid: number) {
    const { body, raw } = await this.get('storageLimitsByFid', { fid });
    const limits = ((body.limits as Record<string, unknown>[]) ?? []).map((l) => ({
      name: String(l.name),
      limit: Number(l.limit),
      used: Number(l.used),
      earliestTimestamp: Number(l.earliestTimestamp ?? 0),
      earliestHash: Array.isArray(l.earliestHash) ? Uint8Array.from(l.earliestHash as number[]) : new Uint8Array(),
      storeType: 0,
    }));
    return { value: StorageLimitsResponse.fromPartial({ limits, units: Number(body.units ?? 0) }), raw };
  }

  async usernameProofs(fid: number) {
    const { body, raw } = await this.get('userNameProofsByFid', { fid });
    const proofs = ((body.proofs as Record<string, unknown>[]) ?? []).map((p) =>
      UserNameProof.fromJSON({ ...(toProtoJson(p) as object), name: Buffer.from(String(p.name ?? '')).toString('base64') }),
    );
    return { proofs, raw };
  }

  async castById(fid: number, hash: Uint8Array): Promise<Message | null> {
    try {
      const { body } = await this.get('castById', { fid, hash: toHex(hash) });
      return messageFromHttpJson(body);
    } catch (e) {
      if (e instanceof TransportError && e.code === 'not_found') return null;
      throw e;
    }
  }

  close(): void {}
}
