// normalized/ records (schemaVersion 1). Every record says where it came from (source) and, for
// protocol data, which signed message backs it (protocolHash), so any normalized fact can be traced to
// a verifiable raw message.

import {
  type Message,
  MessageType,
  OnChainEvent,
  type OnChainEventType,
  onChainEventTypeToJSON,
  Protocol,
  ReactionType,
  SignerEventType,
  type StorageLimitsResponse,
  type UserNameProof,
  UserDataType,
  userNameTypeToJSON,
} from '@farcaster/core';
import { fcTimeToIso, toB64, toHex } from './util.ts';

export const SCHEMA_VERSION = 1;

export interface NormalizedFile<T> {
  schemaVersion: 1;
  dataset: string;
  fid: number;
  records: T[];
}

export const wrap = <T>(dataset: string, fid: number, records: T[]): NormalizedFile<T> => ({ schemaVersion: 1, dataset, fid, records });

type CastIdJson = { fid: number; hash: string };
const castId = (c?: { fid: number; hash: Uint8Array }): CastIdJson | undefined => (c ? { fid: c.fid, hash: toHex(c.hash) } : undefined);
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export interface CastRecord {
  hash: string;
  fid: number;
  kind: 'add' | 'remove';
  timestamp: string;
  text?: string;
  castType?: number;
  mentions?: number[];
  mentionsPositions?: number[];
  embeds?: ({ url: string } | { castId: CastIdJson })[];
  parentCastId?: CastIdJson;
  parentUrl?: string;
  targetHash?: string;
  source: 'protocol';
  protocolHash: string;
}

export function castRecord(m: Message): CastRecord {
  const d = m.data!;
  const hash = toHex(m.hash);
  if (d.type === MessageType.CAST_REMOVE) {
    return { hash, fid: d.fid, kind: 'remove', timestamp: fcTimeToIso(d.timestamp), targetHash: toHex(d.castRemoveBody?.targetHash), source: 'protocol', protocolHash: hash };
  }
  const b = d.castAddBody!;
  return clean({
    hash,
    fid: d.fid,
    kind: 'add' as const,
    timestamp: fcTimeToIso(d.timestamp),
    text: b.text,
    castType: b.type,
    mentions: b.mentions,
    mentionsPositions: b.mentionsPositions,
    embeds: b.embeds.map((e) => (e.castId ? { castId: castId(e.castId)! } : { url: e.url ?? '' })),
    parentCastId: castId(b.parentCastId),
    parentUrl: b.parentUrl,
    source: 'protocol' as const,
    protocolHash: hash,
  });
}

export interface ReactionRecord {
  hash: string;
  fid: number;
  kind: 'add' | 'remove';
  reactionType: 'like' | 'recast' | 'other';
  targetCastId?: CastIdJson;
  targetUrl?: string;
  timestamp: string;
  source: 'protocol';
  protocolHash: string;
}

export function reactionRecord(m: Message): ReactionRecord {
  const d = m.data!;
  const b = d.reactionBody;
  const hash = toHex(m.hash);
  return clean({
    hash,
    fid: d.fid,
    kind: d.type === MessageType.REACTION_REMOVE ? ('remove' as const) : ('add' as const),
    reactionType: b?.type === ReactionType.LIKE ? ('like' as const) : b?.type === ReactionType.RECAST ? ('recast' as const) : ('other' as const),
    targetCastId: castId(b?.targetCastId),
    targetUrl: b?.targetUrl,
    timestamp: fcTimeToIso(d.timestamp),
    source: 'protocol' as const,
    protocolHash: hash,
  });
}

export interface LinkRecord {
  hash: string;
  fid: number;
  kind: 'add' | 'remove' | 'compact_state';
  linkType: string;
  targetFid?: number;
  targetFids?: number[];
  displayTimestamp?: string;
  timestamp: string;
  source: 'protocol';
  protocolHash: string;
}

export function linkRecord(m: Message): LinkRecord {
  const d = m.data!;
  const hash = toHex(m.hash);
  if (d.type === MessageType.LINK_COMPACT_STATE) {
    return { hash, fid: d.fid, kind: 'compact_state', linkType: d.linkCompactStateBody?.type ?? '', targetFids: d.linkCompactStateBody?.targetFids ?? [], timestamp: fcTimeToIso(d.timestamp), source: 'protocol', protocolHash: hash };
  }
  const b = d.linkBody!;
  return clean({
    hash,
    fid: d.fid,
    kind: d.type === MessageType.LINK_REMOVE ? ('remove' as const) : ('add' as const),
    linkType: b.type,
    targetFid: b.targetFid,
    displayTimestamp: b.displayTimestamp ? fcTimeToIso(b.displayTimestamp) : undefined,
    timestamp: fcTimeToIso(d.timestamp),
    source: 'protocol' as const,
    protocolHash: hash,
  });
}

export interface VerificationRecord {
  hash: string;
  fid: number;
  kind: 'add' | 'remove';
  address: string;
  protocol: 'ethereum' | 'solana';
  chainId?: number;
  verificationType?: number;
  timestamp: string;
  source: 'protocol';
  protocolHash: string;
}

export function verificationRecord(m: Message): VerificationRecord {
  const d = m.data!;
  const hash = toHex(m.hash);
  const add = d.verificationAddAddressBody;
  const rem = d.verificationRemoveBody;
  const protocol = (add?.protocol ?? rem?.protocol) === Protocol.SOLANA ? ('solana' as const) : ('ethereum' as const);
  const addrBytes = add?.address ?? rem?.address ?? new Uint8Array();
  // Solana addresses are conventionally shown in base58; keep hex here (lossless), base58 is derivable.
  return clean({
    hash,
    fid: d.fid,
    kind: d.type === MessageType.VERIFICATION_REMOVE ? ('remove' as const) : ('add' as const),
    address: toHex(addrBytes),
    protocol,
    chainId: add?.chainId,
    verificationType: add?.verificationType,
    timestamp: fcTimeToIso(d.timestamp),
    source: 'protocol' as const,
    protocolHash: hash,
  });
}

// Profile fields compared by AC-14, plus the rest of the protocol's user data.
export const PROFILE_FIELDS = ['username', 'displayName', 'bio', 'pfpUrl', 'url'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

const USER_DATA_FIELD: Partial<Record<UserDataType, string>> = {
  [UserDataType.USERNAME]: 'username',
  [UserDataType.DISPLAY]: 'displayName',
  [UserDataType.BIO]: 'bio',
  [UserDataType.PFP]: 'pfpUrl',
  [UserDataType.URL]: 'url',
  [UserDataType.LOCATION]: 'location',
  [UserDataType.TWITTER]: 'twitter',
  [UserDataType.GITHUB]: 'github',
  [UserDataType.BANNER]: 'banner',
  [UserDataType.USER_DATA_PRIMARY_ADDRESS_ETHEREUM]: 'primaryAddressEthereum',
  [UserDataType.USER_DATA_PRIMARY_ADDRESS_SOLANA]: 'primaryAddressSolana',
  [UserDataType.PROFILE_TOKEN]: 'profileToken',
  [UserDataType.LIVE_AT]: 'liveAt',
};

export function protocolProfile(userData: Message[]): { fields: Record<string, string>; hashes: Record<string, string> } {
  const fields: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  const latest: Record<string, number> = {};
  for (const m of userData) {
    const b = m.data?.userDataBody;
    if (!b) continue;
    const name = USER_DATA_FIELD[b.type] ?? `type_${b.type}`;
    if (latest[name] !== undefined && latest[name] > m.data!.timestamp) continue;
    latest[name] = m.data!.timestamp;
    fields[name] = b.value;
    hashes[name] = toHex(m.hash);
  }
  return { fields, hashes };
}

// Client profile (/v2/user-by-fid result.user) mapped onto the same field names. Absent fields are ''.
export function clientProfile(user: Record<string, unknown> | undefined): Record<string, string | number> | null {
  if (!user) return null;
  const profile = (user.profile ?? {}) as Record<string, unknown>;
  const bio = (profile.bio ?? {}) as Record<string, unknown>;
  const pfp = (user.pfp ?? {}) as Record<string, unknown>;
  const location = (profile.location ?? {}) as Record<string, unknown>;
  return {
    username: String(user.username ?? ''),
    displayName: String(user.displayName ?? ''),
    bio: String(bio.text ?? ''),
    pfpUrl: String(pfp.url ?? ''),
    url: String(profile.url ?? ''),
    location: String(location.description ?? ''),
    followerCount: Number(user.followerCount ?? 0),
    followingCount: Number(user.followingCount ?? 0),
  };
}

export interface UsernameProofRecord {
  type: string;
  name: string;
  owner: string;
  fid: number;
  timestamp: string;
  signature: string;
  source: 'protocol';
}

export const usernameProofRecord = (p: UserNameProof): UsernameProofRecord => ({
  type: userNameTypeToJSON(p.type).replace(/^USERNAME_TYPE_/, '').toLowerCase(),
  name: Buffer.from(p.name).toString('utf8'),
  owner: toHex(p.owner),
  fid: p.fid,
  timestamp: new Date(p.timestamp * 1000).toISOString(),
  signature: toB64(p.signature),
  source: 'protocol',
});

export interface OnChainEventRecord {
  type: string;
  fid: number;
  blockNumber: number;
  blockTimestamp: string;
  transactionHash: string;
  logIndex: number;
  event: unknown;
  source: 'protocol';
}

export const onChainEventRecord = (e: OnChainEvent): OnChainEventRecord => ({
  type: onChainEventTypeToJSON(e.type as OnChainEventType).replace(/^EVENT_TYPE_/, '').toLowerCase(),
  fid: e.fid,
  blockNumber: e.blockNumber,
  blockTimestamp: new Date(e.blockTimestamp * 1000).toISOString(),
  transactionHash: toHex(e.transactionHash),
  logIndex: e.logIndex,
  event: OnChainEvent.toJSON(e),
  source: 'protocol',
});

export interface SignerRecord {
  key: string;
  keyType: number;
  eventType: 'add' | 'remove' | 'admin_reset' | 'other';
  metadataType: number;
  blockNumber: number;
  blockTimestamp: string;
  transactionHash: string;
  logIndex: number;
  source: 'protocol';
}

export function signerRecord(e: OnChainEvent): SignerRecord | null {
  const b = e.signerEventBody;
  if (!b) return null;
  return {
    key: toHex(b.key),
    keyType: b.keyType,
    eventType: b.eventType === SignerEventType.ADD ? 'add' : b.eventType === SignerEventType.REMOVE ? 'remove' : b.eventType === SignerEventType.ADMIN_RESET ? 'admin_reset' : 'other',
    metadataType: b.metadataType,
    blockNumber: e.blockNumber,
    blockTimestamp: new Date(e.blockTimestamp * 1000).toISOString(),
    transactionHash: toHex(e.transactionHash),
    logIndex: e.logIndex,
    source: 'protocol',
  };
}

export interface StorageRecord {
  phase: 'before' | 'after';
  units: number;
  limits: { name: string; used: number; limit: number; earliestTimestamp: number }[];
  source: 'protocol';
}

export const storageRecord = (phase: 'before' | 'after', s: StorageLimitsResponse): StorageRecord => ({
  phase,
  units: s.units,
  limits: s.limits.map((l) => ({ name: l.name, used: l.used, limit: l.limit, earliestTimestamp: l.earliestTimestamp })),
  source: 'protocol',
});

export const storageUsed = (s: StorageLimitsResponse): Record<string, number> => Object.fromEntries(s.limits.map((l) => [l.name, l.used]));

// Graph records (following, followers, blocks) merge the protocol set with the client list.
export interface GraphRecord {
  fid: number;
  username?: string;
  displayName?: string;
  since?: string;
  protocolHash?: string;
  inProtocol: boolean;
  inClientList: boolean;
  selfFollow?: boolean;
  source: ('protocol' | 'client')[];
}

export interface ChannelRecord {
  id: string;
  name?: string;
  url?: string;
  followedAt?: number;
  source: 'client';
}

export const channelRecord = (c: Record<string, unknown>): ChannelRecord =>
  clean({
    id: String(c.id ?? ''),
    name: c.name === undefined ? undefined : String(c.name),
    url: c.url === undefined ? undefined : String(c.url),
    followedAt: typeof c.followedAt === 'number' ? c.followedAt : undefined,
    source: 'client' as const,
  });

export interface ContextCastRecord {
  hash: string;
  fid: number;
  found: boolean;
  reasons: ('reply_parent' | 'reaction_target')[];
  timestamp?: string;
  text?: string;
  embeds?: ({ url: string } | { castId: CastIdJson })[];
  parentCastId?: CastIdJson;
  parentUrl?: string;
  source: 'protocol';
  protocolHash?: string;
}

// ---------- private client data (--private) ----------
// Shapes from the official client's types.yml (ApiCast, ApiDirectCastConversationInfoV3,
// ApiDirectCastMessageV3, ApiCastDraft, ApiMutedKeywordsResult, ApiMutedUser, ApiChannelMinimal,
// ApiFrame). Only fields useful for search and import are normalized; raw/client/ keeps every page
// verbatim, so nothing is lost.

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(o) : []);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const optInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);
const optBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
// ApiTimestampMillis. Values below 1e11 are treated as seconds, which no millisecond timestamp after 1973 is.
export const msToIso = (v: unknown): string | undefined => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  const d = new Date(v < 1e11 ? v * 1000 : v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};
const lowerHash = (v: unknown): string | undefined => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? v.toLowerCase() : undefined);

type Embed = { url: string } | { castId: CastIdJson };

// Embeds of a client ApiCast in the protocol's shape: images, videos, URLs and unknowns as {url}, quoted
// casts as {castId}. For images and videos sourceUrl (the URL in the cast) is preferred over url.
export function clientCastEmbeds(cast: Obj): Embed[] {
  const e = o(cast.embeds);
  const out: Embed[] = [];
  for (const x of arr(e.images)) {
    const u = optStr(x.sourceUrl) || optStr(x.url);
    if (u) out.push({ url: u });
  }
  for (const x of arr(e.videos)) {
    const u = optStr(x.sourceUrl) || optStr(x.url);
    if (u) out.push({ url: u });
  }
  for (const x of arr(e.urls)) {
    const og = o(x.openGraph);
    const u = optStr(og.sourceUrl) || optStr(og.url);
    if (u) out.push({ url: u });
  }
  for (const x of arr(e.unknowns)) {
    const u = optStr(x.source);
    if (u) out.push({ url: u });
  }
  for (const x of arr(e.casts)) {
    const h = lowerHash(x.hash);
    const f = optInt(o(x.author).fid);
    if (h && f !== undefined) out.push({ castId: { fid: f, hash: h } });
  }
  return out;
}

// Media URLs of a bookmarked cast (D14, AC-19): every embed URL, as for the user's own casts.
export const bookmarkMediaUrls = (cast: Obj): string[] => [...new Set(clientCastEmbeds(cast).flatMap((e) => ('url' in e ? [e.url] : [])))];

export interface BookmarkRecord {
  position: number; // 1-based order of the app's bookmark list
  hash?: string;
  fid?: number; // author
  username?: string;
  displayName?: string;
  timestamp?: string;
  text?: string;
  embeds?: Embed[];
  embedsSource?: 'protocol' | 'client';
  parentHash?: string;
  parentUrl?: string;
  threadHash?: string;
  channelKey?: string;
  deleted?: boolean;
  inProtocol: boolean;
  protocolHash?: string;
  source: ('client' | 'protocol')[];
}

// One bookmark: the client's cast, plus the signed protocol cast when the node still has it. Text and
// timestamp come from the client (what the app shows, and what a spot check searches for); embeds come
// from the signed message when there is one.
export function bookmarkRecord(cast: Obj, position: number, protocol: Message | null | undefined): BookmarkRecord {
  const author = o(cast.author);
  const rec: BookmarkRecord = clean({
    position,
    hash: lowerHash(cast.hash),
    fid: optInt(author.fid),
    username: optStr(author.username),
    displayName: optStr(author.displayName),
    timestamp: msToIso(cast.timestamp),
    text: optStr(cast.text),
    parentHash: lowerHash(cast.parentHash),
    parentUrl: optStr(cast.parentUrl),
    threadHash: lowerHash(cast.threadHash),
    channelKey: optStr(o(cast.channel).key),
    deleted: optBool(cast.deleted),
    inProtocol: Boolean(protocol),
    source: protocol ? (['client', 'protocol'] as ('client' | 'protocol')[]) : (['client'] as ('client' | 'protocol')[]),
  });
  if (protocol) {
    const r = castRecord(protocol);
    rec.protocolHash = r.protocolHash;
    rec.embeds = r.embeds ?? [];
    rec.embedsSource = 'protocol';
  } else if (cast.embeds !== undefined || cast.hash !== undefined) {
    rec.embeds = clientCastEmbeds(cast);
    rec.embedsSource = 'client';
  }
  return rec;
}

// farcaster.xyz/<username>/<first 10 characters of the hash> is the app's share-link form (inferred
// from the app's links, not from types.yml). Blank when the author has no username.
export const bookmarkUrl = (b: BookmarkRecord): string => (b.username && b.hash ? `https://farcaster.xyz/${b.username}/${b.hash.slice(0, 10)}` : '');

export interface DmConversationRecord {
  index: number;
  conversationId: string;
  categories: string[];
  isGroup?: boolean;
  name?: string;
  participantFids: number[];
  createdAt?: string;
  messages: number;
  pages: number;
  exhausted: boolean;
  source: 'client';
}

export function dmConversationRecord(c: { index: number; conversationId: string; categories: string[]; info: Obj; pages: number; messages: unknown[]; lastCursorEmpty: boolean }): DmConversationRecord {
  return clean({
    index: c.index,
    conversationId: c.conversationId,
    categories: c.categories,
    isGroup: optBool(c.info.isGroup),
    name: optStr(c.info.name),
    participantFids: arr(c.info.participants).map((p) => optInt(p.fid)).filter((x): x is number => x !== undefined),
    createdAt: msToIso(c.info.createdAt),
    messages: c.messages.length,
    pages: c.pages,
    exhausted: c.lastCursorEmpty,
    source: 'client' as const,
  });
}

export interface DmMessageRecord {
  conversationId: string;
  messageId?: string;
  senderFid?: number;
  timestamp?: string;
  type?: string;
  text?: string;
  isDeleted?: boolean;
  inReplyToMessageId?: string;
  source: 'client';
}

export const dmMessageRecord = (conversationId: string, m: Obj): DmMessageRecord =>
  clean({
    conversationId,
    messageId: optStr(m.messageId),
    senderFid: optInt(m.senderFid),
    timestamp: msToIso(m.serverTimestamp),
    type: optStr(m.type),
    text: optStr(m.message),
    isDeleted: optBool(m.isDeleted),
    inReplyToMessageId: optStr(o(m.inReplyTo).messageId),
    source: 'client' as const,
  });

export interface DraftRecord {
  draftId?: string;
  casts: { text?: string; embeds: string[] }[];
  parentHash?: string;
  channelKey?: string;
  scheduledAt?: string;
  cron?: string;
  source: 'client';
}

// ApiCastDraft has one cast; a caststorm draft (ApiCaststormDraft) has several. Both normalize to casts[].
export function draftRecord(d: Obj): DraftRecord {
  const one = o(d.cast);
  const casts = Array.isArray(d.casts) ? arr(d.casts) : d.cast !== undefined ? [one] : [];
  const parent = o(d.parent ?? one.parent);
  return clean({
    draftId: optStr(d.draftId),
    casts: casts.map((c) => clean({ text: optStr(c.text), embeds: Array.isArray(c.embeds) ? c.embeds.filter((x): x is string => typeof x === 'string') : [] })),
    parentHash: lowerHash(parent.hash),
    channelKey: optStr(d.channelKey ?? one.channelKey),
    scheduledAt: msToIso(d.scheduledAt),
    cron: optStr(d.cron),
    source: 'client' as const,
  });
}

export const mutedUserRecord = (m: Obj) =>
  clean({ fid: optInt(m.mutedFid), username: optStr(o(m.mutedUser).username), displayName: optStr(o(m.mutedUser).displayName), mutedAt: msToIso(m.createdAt), source: 'client' as const });

export const mutedChannelRecord = (c: Obj) => clean({ key: String(c.key ?? ''), name: optStr(c.name), source: 'client' as const });

export const miniAppRecord = (f: Obj) =>
  clean({ domain: String(f.domain ?? ''), name: optStr(f.name), homeUrl: optStr(f.homeUrl), iconUrl: optStr(f.iconUrl), id: optStr(f.id), authorFid: optInt(o(f.author).fid), source: 'client' as const });
