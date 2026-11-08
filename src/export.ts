// castsnap export: protocol data (gRPC, with HTTP fallbacks) + client data (public, and private with --private)
// -> one immutable directory. Layout and acceptance criteria: docs/SPEC.md. Three lanes run concurrently
// because they use different hosts (one request at a time per host): protocol, client API, media.
//
// With --private the session token is checked against /v2/me before anything is written: a token that is
// rejected, or that belongs to another FID, aborts the run with no output directory.

import {
  Message,
  MessageType,
  OnChainEvent,
  OnChainEventType,
  SignerEventType,
  SignersByFidResponse,
  SignerSource,
  StorageLimitsResponse,
  UserNameProof,
} from '@farcaster/core';
import { type AuthCheck, ClientApi, CLIENT_BASES } from './client.ts';
import { toCsv } from './csv.ts';
import { FARCASTER_EPOCH_S, type KeyTarget, KeyMessageSearch, keyOf, messageData, SEARCH_LIMITS, shortKey } from './gasless.ts';
import { downloadMedia, type MediaIndexRow, type MediaOrigin, type MediaRef, mediaStats, type MediaStats, parseMediaScope, type Resolver } from './media.ts';
import {
  bookmarkMediaUrls,
  type BookmarkRecord,
  bookmarkRecord,
  bookmarkUrl,
  castRecord,
  channelRecord,
  clientProfile,
  type ContextCastRecord,
  dmConversationRecord,
  dmMessageRecord,
  draftRecord,
  miniAppRecord,
  mutedChannelRecord,
  mutedUserRecord,
  type GraphRecord,
  linkRecord,
  onChainEventRecord,
  protocolProfile,
  reactionRecord,
  signerRecord,
  storageRecord,
  usernameProofRecord,
  verificationRecord,
  wrap,
} from './normalize.ts';
import { collectPages, PaginationError, withRetry } from './protocol/paginate.ts';
import { GrpcTransport } from './protocol/grpc.ts';
import { HttpTransport } from './protocol/http.ts';
import { type ProtocolTransport, type Store, STORE_LIMIT_NAME, TransportError } from './protocol/types.ts';
import { clientEdges, mergeGraph, type ProtoEdge, reconcile } from './reconcile.ts';
import { capturePrivate, type CaptureHelpers, DM_CATEGORIES, emptyPrivateData, mutedKeywordList, type PrivateData } from './private.ts';
import { RECONCILIATION_SCHEMA, SCHEMAS } from './schemas.ts';
import { makeRedactor, registerSecret, safeErrorText, scanTreeForSecrets, tokenFromEnv } from './secrets.ts';
import { pickStatus, shapeNote, statusFromMe, statusFromProfile, statusLine, type StatusFields } from './status.ts';
import { errMessage, fcTimeToIso, fromHex, interrupt, LIBRARIES, toHex, VERSION } from './util.ts';
import { ExportWriter } from './writer.ts';

export const DEFAULT_GRPC = 'snap.farcaster.xyz:3383';
// Farcaster's own public Snapchain nodes; snapchain lists both in src/network/mesh/nodes.rs. castsnap falls back only
// between these, gRPC first (snap, then crackle) and then HTTP in the same order, so one export never mixes two
// networks. haatz.quilibrium.com runs Hypersnap, a Snapchain fork planned to become a separate chain, so it is
// used only when passed with --hub.
export const SNAPCHAIN_NODES = [
  { grpc: DEFAULT_GRPC, http: 'https://snap.farcaster.xyz:3381' },
  { grpc: 'crackle.farcaster.xyz:3383', http: 'https://crackle.farcaster.xyz:3381' },
];

export interface SourceEntry {
  kind: 'protocol' | 'client' | 'media';
  host: string | null;
  paginated: boolean;
  status: string;
  pages: number;
  items: number;
  end?: string;
  lastCursorEmpty: boolean | null;
  files: string[];
  fallbackErrors?: string[];
  notes?: string[];
}

export interface DatasetEntry {
  name: string;
  status: string;
  count: number | null;
  sources: string[];
  lastCursorEmpty: boolean | null;
  notes: string[];
}

export interface Manifest {
  tool: 'castsnap' | 'fcx'; // 'fcx': exports written before the rename
  version: string;
  schemaVersion: 1;
  fid: number;
  startedAt: string;
  finishedAt?: string;
  node: string;
  libraries: typeof LIBRARIES;
  options: { media: string; hub: string | null; private: boolean; base: string | null };
  hosts: { protocol: string[]; client: string[] };
  // --private only: the /v2/me check made before anything was written.
  authCheck?: { host: string; fid: number; attempts: { base: string; status: number }[] };
  // --private only: one entry per direct-cast conversation (manifest.sources has the aggregate).
  directCasts?: { index: number; conversationId: string; categories: string[]; dir: string; status: string; pages: number; messages: number; lastCursorEmpty: boolean; limitUsed?: number }[];
  // The account's status in the app, from answers castsnap already saves (src/status.ts): the printed
  // line, the answer it came from, and each answer's fields (client:me on --private runs only).
  accountStatus?: { line: string; source: string; fields: Record<string, StatusFields | null> };
  datasets: Record<string, DatasetEntry>;
  sources: Record<string, SourceEntry>;
  counts: Record<string, unknown>;
  media?: MediaStats & { byOrigin?: Record<string, MediaStats> };
  interrupted: boolean;
  tokenScan: { ran: boolean; note: string; filesScanned?: number; filesWithToken?: number };
  laneErrors?: string[];
  result?: 'ok' | 'errors' | 'interrupted';
}

export interface ExportOptions {
  fid: number;
  out: string;
  // own, bookmarks, own,bookmarks, or none. Bookmarks media needs --private.
  media: string;
  hub?: string;
  // Client API host chosen by the user (--base): no host fallback.
  base?: string;
  // --private: fetch bookmarks, direct casts, drafts, mutes and mini apps with the session token.
  private?: boolean;
  token?: string;
  transports?: ProtocolTransport[];
  client?: ClientApi;
  mediaFetch?: typeof fetch;
  mediaResolve?: Resolver;
  mediaWait?: (ms: number) => Promise<void>;
  retryWait?: (ms: number) => Promise<void>;
  keySearchLimits?: typeof SEARCH_LIMITS;
  log?: (s: string) => void;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export interface ExportResult {
  dir: string;
  exitCode: number;
  manifest: Manifest;
}

// Thrown before anything is written: the token was rejected or belongs to another FID.
export class AuthCheckError extends Error {
  readonly check?: AuthCheck;
  constructor(message: string, check?: AuthCheck) {
    super(message);
    this.name = 'AuthCheckError';
    this.check = check;
  }
}

const NOT_REQUESTED = 'unavailable:private-not-requested';
// The own moderation record and the stayed list are information: whatever their status, they never
// make the export an error.
const INFO_DATASETS = new Set(['D19', 'D20']);
const pad = (n: number) => String(n).padStart(4, '0');
const finished = (s: string | undefined) => s === 'complete' || s === 'empty';

// A dataset's sources that are missing because their lane (the name's prefix: protocol, client or media)
// stopped early. Any such source makes the dataset error:<lane>-lane-aborted, so a stopped lane never
// leaves a dataset looking complete or not requested.
export function laneAbortStatus(sources: string[], registered: (source: string) => boolean, failedLanes: ReadonlySet<string>): { status: string; lane: string; missing: string[] } | null {
  const laneOf = (s: string) => s.split(':')[0];
  const missing = sources.filter((s) => !registered(s) && failedLanes.has(laneOf(s)));
  if (!missing.length) return null;
  const lane = laneOf(missing[0]);
  return { status: `error:${lane}-lane-aborted`, lane, missing };
}

const isHttpBase = (s: string) => /^https?:\/\//.test(s);
const hostOf = (s: string) => {
  try {
    return new URL(isHttpBase(s) ? s : `grpc://${s}`).hostname.toLowerCase();
  } catch {
    return '';
  }
};
const SNAPCHAIN_HOSTS = new Set(SNAPCHAIN_NODES.map((n) => hostOf(n.grpc)));

// --hub is tried first. Without it, or when it names one of Farcaster's own Snapchain nodes, the rest of
// those nodes follow; any other node gets no fallback, since castsnap cannot tell which network it serves.
export function defaultTransports(hub?: string): ProtocolTransport[] {
  const own = [...SNAPCHAIN_NODES.map((n) => n.grpc), ...SNAPCHAIN_NODES.map((n) => n.http)];
  const specs = !hub ? own : SNAPCHAIN_HOSTS.has(hostOf(hub)) ? [hub, ...own] : [hub];
  const list: ProtocolTransport[] = [];
  const seen = new Set<string>();
  for (const s of specs) {
    const label = isHttpBase(s) ? s.replace(/\/+$/, '') : `grpc://${s}`;
    if (seen.has(label)) continue;
    seen.add(label);
    list.push(isHttpBase(s) ? new HttpTransport(s) : new GrpcTransport(s));
  }
  return list;
}

export async function runExport(opts: ExportOptions): Promise<ExportResult> {
  const fid = opts.fid;
  const envToken = tokenFromEnv(opts.env);
  const token = opts.private ? opts.token : undefined;
  const secrets = [...new Set([token, envToken].filter((x): x is string => Boolean(x)))];
  for (const s of secrets) registerSecret(s);
  const redact = makeRedactor(secrets);
  const log = (s: string) => (opts.log ?? ((x: string) => process.stdout.write(x + '\n')))(redact(s));
  const now = opts.now ?? (() => new Date());
  const scope = parseMediaScope(opts.media);
  if (!scope) throw new Error(`invalid media scope: ${opts.media}`);
  const client = opts.client ?? new ClientApi({ log, token, bases: opts.base ? [opts.base] : CLIENT_BASES, explicitBase: Boolean(opts.base) });

  // Private runs: identify the token's account before anything is written.
  let auth: AuthCheck | undefined;
  if (opts.private) {
    if (!token) throw new AuthCheckError('--private needs a session token. Nothing was written.');
    auth = await client.authCheck(fid);
    if (!auth.ok) throw new AuthCheckError(redact(`${auth.message} Nothing was written.`), auth);
  }

  const transports = opts.transports ?? defaultTransports(opts.hub);
  const writer = ExportWriter.create(opts.out, fid, now());

  const manifest: Manifest = {
    tool: 'castsnap',
    version: VERSION,
    schemaVersion: 1,
    fid,
    startedAt: now().toISOString(),
    node: process.version,
    libraries: LIBRARIES,
    options: { media: opts.media, hub: opts.hub ?? null, private: Boolean(opts.private), base: opts.base ?? null },
    hosts: { protocol: transports.map((t) => t.label), client: client.bases },
    ...(auth ? { authCheck: { host: auth.base, fid: auth.fid!, attempts: auth.attempts.map((a) => ({ base: a.base, status: a.status })) } } : {}),
    datasets: {},
    sources: {},
    counts: {},
    interrupted: false,
    tokenScan: { ran: false, note: 'not run yet' },
  };
  const S = manifest.sources;
  // The source each lane started last, named if the lane stops.
  const laneAt: Record<string, string> = {};

  log(`Account: fid ${fid}${auth?.username ? ` (@${auth.username})` : ''}`);
  if (auth) log(`Token:   ${auth.message}`);
  log(`Output:  ${writer.root}`);
  log('Fetching:');
  const report = (name: string) => {
    const s = S[name];
    log(`  ${name.padEnd(40)} ${s.status.padEnd(12)} pages=${s.pages} items=${s.items}${s.host ? `  via ${s.host}` : ''}`);
  };

  // ---------- protocol helpers ----------
  // A transport that exhausts its retries on a retryable error is skipped for the rest of the run, so a
  // dead host costs one retry cycle, not one per dataset.
  const down = new Set<ProtocolTransport>();
  const usable = (fallbackErrors: string[]) =>
    transports.filter((t) => {
      if (down.has(t)) fallbackErrors.push(`${t.label}: skipped (failed earlier in this run)`);
      return !down.has(t);
    });
  const markDown = (t: ProtocolTransport, e: unknown) => {
    if (e instanceof TransportError && e.retryable && !down.has(t)) {
      down.add(t);
      log(`    ${t.label} marked down for this run`);
    }
  };
  const retry = <T>(fn: () => Promise<T>) => withRetry(fn, { wait: opts.retryWait, onRetry: (e, n, ms) => log(`    retry ${n} in ${Math.round(ms / 1000)}s: ${redact(errMessage(e))}`) });

  function writeMessages(name: string, messages: Message[]): string[] {
    writer.writeDelimited(`raw/protocol/${name}.pb`, messages.map((m) => Message.encode(m).finish()));
    writer.writeJsonl(`raw/protocol/${name}.jsonl`, messages.map((m) => Message.toJSON(m)));
    return [`raw/protocol/${name}.pb`, `raw/protocol/${name}.jsonl`];
  }
  function writeEvents(name: string, events: OnChainEvent[]): string[] {
    writer.writeDelimited(`raw/protocol/${name}.pb`, events.map((e) => OnChainEvent.encode(e).finish()));
    writer.writeJsonl(`raw/protocol/${name}.jsonl`, events.map((e) => OnChainEvent.toJSON(e)));
    return [`raw/protocol/${name}.pb`, `raw/protocol/${name}.jsonl`];
  }
  function writeHttpPages(name: string, raws: string[]): string[] {
    return raws.map((r, i) => {
      const rel = `raw/protocol/http/${name}/page-${pad(i + 1)}.json`;
      writer.write(rel, r);
      return rel;
    });
  }

  // Paginated protocol fetch with transport fallback. Pagination always stays on one transport.
  async function protoPaged<T>(
    name: string,
    page: (t: ProtocolTransport, token?: Uint8Array) => Promise<{ items: T[]; nextPageToken?: Uint8Array; raw?: string }>,
    write: (items: T[]) => string[],
  ): Promise<{ items: T[]; transport: ProtocolTransport | null }> {
    const entry: SourceEntry = { kind: 'protocol', host: null, paginated: true, status: 'error:not-started', pages: 0, items: 0, lastCursorEmpty: false, files: [] };
    S[name] = entry;
    laneAt.protocol = name;
    const fallbackErrors: string[] = [];
    for (const t of usable(fallbackErrors)) {
      if (interrupt.requested) break;
      try {
        const r = await collectPages((token) => retry(() => page(t, token)), { isInterrupted: () => interrupt.requested });
        Object.assign(entry, { host: t.label, pages: r.pages, items: r.items.length, end: r.end, lastCursorEmpty: true, status: r.items.length ? 'complete' : 'empty' });
        entry.files = [...write(r.items), ...(t.kind === 'http' ? writeHttpPages(name.replace(/^protocol:/, ''), r.raws) : [])];
        if (fallbackErrors.length) entry.fallbackErrors = fallbackErrors;
        if (t.kind === 'http') entry.notes = ['served by the HTTP API: dataBytes rebuilt from JSON data'];
        report(name);
        return { items: r.items, transport: t };
      } catch (e) {
        fallbackErrors.push(redact(`${t.label}: ${errMessage(e)}`));
        if (e instanceof PaginationError && e.message === 'interrupted') break;
        markDown(t, e);
      }
    }
    entry.fallbackErrors = fallbackErrors;
    entry.status = interrupt.requested ? 'interrupted' : fallbackErrors.length && fallbackErrors.every((x) => /has no endpoint|skipped \(failed earlier/.test(x)) && fallbackErrors.some((x) => /has no endpoint/.test(x)) ? 'unavailable:no-transport-endpoint' : `error:${fallbackErrors[fallbackErrors.length - 1] ?? 'unknown'}`;
    report(name);
    return { items: [], transport: null };
  }

  async function protoSingle<T>(name: string, call: (t: ProtocolTransport) => Promise<T>, write: (v: T, t: ProtocolTransport) => string[], count: (v: T) => number): Promise<T | null> {
    const entry: SourceEntry = { kind: 'protocol', host: null, paginated: false, status: 'error:not-started', pages: 0, items: 0, lastCursorEmpty: null, files: [] };
    S[name] = entry;
    laneAt.protocol = name;
    const fallbackErrors: string[] = [];
    for (const t of usable(fallbackErrors)) {
      if (interrupt.requested) break;
      try {
        const v = await retry(() => call(t));
        Object.assign(entry, { host: t.label, pages: 1, items: count(v), status: count(v) ? 'complete' : 'empty' });
        entry.files = write(v, t);
        if (fallbackErrors.length) entry.fallbackErrors = fallbackErrors;
        report(name);
        return v;
      } catch (e) {
        fallbackErrors.push(redact(`${t.label}: ${errMessage(e)}`));
        markDown(t, e);
      }
    }
    entry.fallbackErrors = fallbackErrors;
    entry.status = interrupt.requested ? 'interrupted' : fallbackErrors.length && fallbackErrors.every((x) => /has no endpoint|skipped \(failed earlier/.test(x)) && fallbackErrors.some((x) => /has no endpoint/.test(x)) ? 'unavailable:no-transport-endpoint' : `error:${fallbackErrors[fallbackErrors.length - 1] ?? 'unknown'}`;
    report(name);
    return null;
  }

  const storageSource = (phase: 'before' | 'after') =>
    protoSingle(
      `protocol:storage-${phase}`,
      (t) => t.storageLimits(fid),
      (v, t) => {
        writer.write(`raw/protocol/storage-${phase}.pb`, StorageLimitsResponse.encode(v.value).finish());
        writer.writeJson(`raw/protocol/storage-${phase}.json`, StorageLimitsResponse.toJSON(v.value));
        const files = [`raw/protocol/storage-${phase}.pb`, `raw/protocol/storage-${phase}.json`];
        if (t.kind === 'http' && v.raw) files.push(...writeHttpPages(`storage-${phase}`, [v.raw]));
        return files;
      },
      (v) => v.value.limits.length,
    );

  // ---------- lanes ----------
  const storageBefore = await storageSource('before');

  const stores: Record<Store, Message[]> = { casts: [], reactions: [], links: [], userData: [], verifications: [], storageLends: [] };
  const storeTransport: Partial<Record<Store, ProtocolTransport | null>> = {};
  let followerMsgs: Message[] = [];
  let compact: Message[] = [];
  let proofs: UserNameProof[] = [];
  const events: Record<string, OnChainEvent[]> = {};
  let activeSigners: OnChainEvent[] = [];
  let signerPages: SignersByFidResponse[] = [];
  let keyMessages: Message[] = [];
  const contextCasts: ContextCastRecord[] = [];
  const contextMsgs: Message[] = [];

  let castsReady!: (refs: MediaRef[]) => void;
  const castsPromise = new Promise<MediaRef[]>((r) => (castsReady = r));
  // Resolved by the client lane once bookmarks are fetched (null: not fetched or incomplete).
  let bookmarksReady!: (b: Record<string, unknown>[] | null) => void;
  const bookmarksPromise = new Promise<Record<string, unknown>[] | null>((r) => (bookmarksReady = r));
  if (!opts.private) bookmarksReady(null);
  const bookmarkProtocol = new Map<string, Message | null>(); // bookmark hash -> signed cast, or null if not found
  const bookmarkMsgs: Message[] = [];

  const fileNames: Record<Store, string> = { casts: 'casts', reactions: 'reactions', links: 'links', userData: 'user-data', verifications: 'verifications', storageLends: 'storage-lends' };

  const protocolLane = async () => {
    try {
      for (const store of ['casts', 'reactions', 'links', 'userData', 'verifications', 'storageLends'] as Store[]) {
        const name = `protocol:${fileNames[store]}`;
        const r = await protoPaged(name, (t, tok) => t.allByFid(store, fid, tok).then((p) => ({ items: p.messages, nextPageToken: p.nextPageToken, raw: p.raw })), (items) => writeMessages(fileNames[store], items));
        stores[store] = r.items;
        storeTransport[store] = r.transport;
        if (store === 'casts') {
          const refs: MediaRef[] = [];
          for (const m of r.items) for (const e of m.data?.castAddBody?.embeds ?? []) if (e.url) refs.push({ url: e.url, castHash: toHex(m.hash) });
          castsReady(refs);
        }
      }
      const c = await protoPaged('protocol:link-compact-state', (t) => t.linkCompactState(fid).then((p) => ({ items: p.messages })), (items) => writeMessages('link-compact-state', items));
      compact = c.items;
      const p = await protoSingle(
        'protocol:username-proofs',
        (t) => t.usernameProofs(fid),
        (v) => {
          writer.writeDelimited('raw/protocol/username-proofs.pb', v.proofs.map((x) => UserNameProof.encode(x).finish()));
          writer.writeJsonl('raw/protocol/username-proofs.jsonl', v.proofs.map((x) => UserNameProof.toJSON(x)));
          return ['raw/protocol/username-proofs.pb', 'raw/protocol/username-proofs.jsonl'];
        },
        (v) => v.proofs.length,
      );
      proofs = p?.proofs ?? [];
      for (const type of [OnChainEventType.EVENT_TYPE_SIGNER, OnChainEventType.EVENT_TYPE_SIGNER_MIGRATED, OnChainEventType.EVENT_TYPE_ID_REGISTER, OnChainEventType.EVENT_TYPE_STORAGE_RENT, OnChainEventType.EVENT_TYPE_TIER_PURCHASE]) {
        const label = OnChainEventType[type].replace(/^EVENT_TYPE_/, '').toLowerCase().replace(/_/g, '-');
        const r = await protoPaged(`protocol:onchain-events-${label}`, (t, tok) => t.onChainEvents(fid, type, tok).then((x) => ({ items: x.events, nextPageToken: x.nextPageToken, raw: x.raw })), (items) => writeEvents(`onchain-events-${label}`, items));
        events[label] = r.items;
      }
      const sg = await protoPaged('protocol:onchain-signers-active', (t, tok) => t.onChainSigners(fid, tok).then((x) => ({ items: x.events, nextPageToken: x.nextPageToken, raw: x.raw })), (items) => writeEvents('onchain-signers-active', items));
      activeSigners = sg.items;
      await fetchSigners();
      await fetchKeyMessages();
      const fo = await protoPaged('protocol:followers', (t, tok) => t.linksByTarget(fid, tok).then((x) => ({ items: x.messages, nextPageToken: x.nextPageToken, raw: x.raw })), (items) => writeMessages('followers', items));
      followerMsgs = fo.items;
      await fetchContextCasts();
      await fetchBookmarkedCasts();
    } finally {
      castsReady([]);
    }
  };

  // Snapchain's unified signer list (GetSignersByFid): on-chain keys and gasless keys added by a KEY_ADD
  // message. Each page is kept whole. The on-chain signer events stay the record for on-chain keys: this
  // list omits removed ones.
  async function fetchSigners() {
    const name = 'protocol:signers-by-fid';
    const r = await protoPaged(
      name,
      (t, tok) =>
        t.signersByFid(fid, tok).then((x) => {
          if (!tok) signerPages = [];
          signerPages.push(x.response);
          return { items: x.response.signers, nextPageToken: x.nextPageToken, raw: x.raw };
        }),
      () => {
        writer.writeDelimited('raw/protocol/signers-by-fid.pb', signerPages.map((p) => SignersByFidResponse.encode(p).finish()));
        writer.writeJsonl('raw/protocol/signers-by-fid.jsonl', signerPages.map((p) => SignersByFidResponse.toJSON(p)));
        return ['raw/protocol/signers-by-fid.pb', 'raw/protocol/signers-by-fid.jsonl'];
      },
    );
    if (!r.transport) signerPages = [];
    const first = signerPages[0];
    if (first) {
      const signers = signerPages.flatMap((p) => p.signers);
      const gasless = signers.filter((s) => s.source === SignerSource.OFFCHAIN).length;
      S[name].notes = [...(S[name].notes ?? []), `on-chain ${signers.length - gasless}, gasless ${gasless} (expired gasless keys stay listed); node's gaslessSignerCount ${first.gaslessSignerCount}; currentUserNonce ${first.currentUserNonce}`];
    }
  }

  // The FID's KEY_ADD and KEY_REMOVE messages (AC-04 (c)). No node API lists them, so they are found in
  // shard-0 blocks: the latest KEY_ADD of each listed gasless key, and, for each key that signed own
  // messages but has no on-chain ADD event, the latest KEY_ADD at or before its earliest message.
  // KEY_REMOVEs are kept when they fall in a scanned block.
  async function fetchKeyMessages() {
    const name = 'protocol:key-messages';
    const entry: SourceEntry = { kind: 'protocol', host: null, paginated: false, status: 'error:not-started', pages: 0, items: 0, lastCursorEmpty: null, files: [] };
    S[name] = entry;
    laneAt.protocol = name;
    const notes: string[] = [];
    const targets: KeyTarget[] = [];
    for (const s of signerPages.flatMap((p) => p.signers)) {
      if (s.source !== SignerSource.OFFCHAIN) continue;
      if (s.addedAt) targets.push({ key: toHex(s.key), kind: 'latest', at: s.addedAt - FARCASTER_EPOCH_S });
      else notes.push(`gasless key ${shortKey(toHex(s.key))} listed without addedAt: its latest KEY_ADD cannot be located`);
    }
    const onchain = new Set((events.signer ?? []).filter((e) => e.signerEventBody?.eventType === SignerEventType.ADD).map((e) => toHex(e.signerEventBody?.key)));
    const earliest = new Map<string, number>();
    for (const m of [...Object.values(stores).flat(), ...compact]) {
      const k = toHex(m.signer);
      const ts = messageData(m)?.timestamp;
      if (onchain.has(k) || ts === undefined) continue;
      earliest.set(k, Math.min(ts, earliest.get(k) ?? ts));
    }
    const finish = (status: string, search?: KeyMessageSearch) => {
      const found = [...(search?.found.values() ?? [])].sort((a, b) => a.data.timestamp - b.data.timestamp || toHex(a.message.hash).localeCompare(toHex(b.message.hash)));
      keyMessages = found.map((f) => f.message);
      // Where each one was found, so it can be fetched again: GetBlocks with the block number.
      writer.writeJsonl('raw/protocol/key-message-blocks.jsonl', found.map((f) => ({ hash: toHex(f.message.hash), type: MessageType[f.data.type], key: keyOf(f.data), timestamp: fcTimeToIso(f.data.timestamp), block: f.block, blockTimestamp: fcTimeToIso(f.blockTimestamp), blockHash: toHex(f.blockHash) })));
      entry.files = [...writeMessages('key-messages', keyMessages), 'raw/protocol/key-message-blocks.jsonl'];
      entry.items = keyMessages.length;
      entry.pages = search ? search.lookups + search.blocksScanned : 0;
      entry.status = status;
      if (search) notes.push(`KEY_ADD ${found.filter((f) => f.data.type === MessageType.KEY_ADD).length}, KEY_REMOVE ${found.filter((f) => f.data.type === MessageType.KEY_REMOVE).length}; shard-0 blocks scanned ${search.blocksScanned} (plus ${search.lookups} timestamp lookups): ${search.ranges().join(', ') || 'none'}`);
      notes.push('KEY_REMOVE messages are captured only when they fall in a scanned block: no node API lists them');
      entry.notes = notes;
      report(name);
    };
    if (!targets.length && !earliest.size) {
      notes.unshift('no gasless key is listed, and every own message is signed by a key with an on-chain ADD event: no KEY_ADD to find');
      return finish('empty');
    }
    notes.unshift(`targets: the latest KEY_ADD of ${targets.length} listed gasless key(s); keys signing own messages without an on-chain ADD event: ${earliest.size}`);
    const fallbackErrors: string[] = [];
    for (const t of usable(fallbackErrors)) {
      if (interrupt.requested) break;
      let top: number;
      try {
        top = await retry(() => t.shardZeroHeight());
      } catch (e) {
        fallbackErrors.push(redact(`${t.label}: ${errMessage(e)}`));
        markDown(t, e);
        continue;
      }
      entry.host = t.label;
      if (fallbackErrors.length) entry.fallbackErrors = fallbackErrors;
      const search = new KeyMessageSearch({ height: async () => top, blocks: (a, b) => retry(() => t.shardZeroBlocks(a, b)) }, fid, { limits: opts.keySearchLimits, log, isInterrupted: () => interrupt.requested });
      const missing: KeyTarget[] = [];
      try {
        for (const target of targets) if (!(await search.find(target))) missing.push(target);
        for (const [key, at] of earliest) {
          const target: KeyTarget = { key, kind: 'before', at };
          if (!(await search.find(target))) missing.push(target);
        }
      } catch (e) {
        markDown(t, e);
        return finish(redact(`error:${errMessage(e)}`), search);
      }
      for (const m of missing) notes.push(`not found: ${m.kind === 'latest' ? 'the latest KEY_ADD' : 'a KEY_ADD at or before the earliest own message'} of key ${shortKey(m.key)} (${fcTimeToIso(m.at)})`);
      if (interrupt.requested) return finish('interrupted', search);
      return finish(missing.length ? `unavailable:${missing.length}-key-adds-not-found-in-scanned-blocks` : search.found.size ? 'complete' : 'empty', search);
    }
    entry.fallbackErrors = fallbackErrors;
    finish(interrupt.requested ? 'interrupted' : fallbackErrors.length && fallbackErrors.every((x) => /has no endpoint|skipped \(failed earlier/.test(x)) && fallbackErrors.some((x) => /has no endpoint/.test(x)) ? 'unavailable:no-transport-endpoint' : `error:${fallbackErrors[fallbackErrors.length - 1] ?? 'unknown'}`);
  }

  // D3: the signed protocol cast behind each bookmark, where the node still has it. Casts already
  // fetched (own casts, context casts) are reused rather than fetched again.
  async function fetchBookmarkedCasts() {
    const list = await bookmarksPromise;
    if (!opts.private) return;
    const name = 'protocol:bookmarked-casts';
    const entry: SourceEntry = { kind: 'protocol', host: null, paginated: false, status: 'error:not-started', pages: 0, items: 0, lastCursorEmpty: null, files: [] };
    S[name] = entry;
    laneAt.protocol = name;
    if (!list) {
      entry.status = 'unavailable:bookmarks-not-captured';
      report(name);
      return;
    }
    const known = new Map<string, Message>();
    for (const m of [...stores.casts, ...contextMsgs]) known.set(toHex(m.hash), m);
    let notFound = 0;
    let failed = 0;
    let reused = 0;
    let notProtocolHash = 0;
    let lookups = 0;
    const hosts = new Set<string>();
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const b of list) {
      if (interrupt.requested) break;
      const hash = typeof b.hash === 'string' ? b.hash.toLowerCase() : '';
      const author = Number((b.author as { fid?: unknown } | undefined)?.fid);
      if (!/^0x[0-9a-f]{40}$/.test(hash) || !Number.isInteger(author)) {
        notProtocolHash++;
        continue;
      }
      if (seen.has(hash)) continue;
      seen.add(hash);
      const k = known.get(hash);
      if (k) {
        reused++;
        bookmarkProtocol.set(hash, k);
        bookmarkMsgs.push(k);
        continue;
      }
      if (++lookups % 500 === 0) log(`    bookmarked casts: ${lookups} looked up`);
      let msg: Message | null | undefined;
      for (const tr of transports) {
        if (down.has(tr)) continue;
        try {
          msg = await retry(() => tr.castById(author, fromHex(hash)));
          hosts.add(tr.label);
          break;
        } catch (e) {
          if (errors.length < 5) errors.push(redact(`${tr.label}: ${errMessage(e)}`));
          markDown(tr, e);
        }
      }
      if (msg === undefined) failed++;
      else if (msg === null) {
        notFound++;
        bookmarkProtocol.set(hash, null);
      } else {
        bookmarkProtocol.set(hash, msg);
        bookmarkMsgs.push(msg);
      }
    }
    entry.files = writeMessages('bookmarked-casts', bookmarkMsgs);
    entry.host = [...hosts].join(', ') || null;
    entry.items = bookmarkMsgs.length;
    entry.pages = lookups;
    entry.notes = [`bookmarks ${list.length}; signed casts found ${bookmarkMsgs.length} (already fetched ${reused}, looked up ${lookups}); not found (deleted or pruned) ${notFound}; no protocol hash ${notProtocolHash}; lookups failed ${failed}`];
    if (errors.length) entry.fallbackErrors = errors;
    entry.status = interrupt.requested ? 'interrupted' : failed ? `error:${failed}-lookups-failed` : bookmarkMsgs.length ? 'complete' : 'empty';
    report(name);
  }

  // D15: parents of the user's replies and casts the user reacted to. Own casts are already exported.
  async function fetchContextCasts() {
    const name = 'protocol:context-casts';
    const entry: SourceEntry = { kind: 'protocol', host: null, paginated: false, status: 'error:not-started', pages: 0, items: 0, lastCursorEmpty: null, files: [] };
    S[name] = entry;
    laneAt.protocol = name;
    const own = new Set(stores.casts.map((m) => toHex(m.hash)));
    const targets = new Map<string, { fid: number; hash: Uint8Array; reasons: Set<'reply_parent' | 'reaction_target'> }>();
    const add = (c: { fid: number; hash: Uint8Array } | undefined, reason: 'reply_parent' | 'reaction_target') => {
      if (!c) return;
      const h = toHex(c.hash);
      if (own.has(h)) return;
      const t = targets.get(h) ?? { fid: c.fid, hash: c.hash, reasons: new Set() };
      t.reasons.add(reason);
      targets.set(h, t);
    };
    for (const m of stores.casts) if (m.data?.type === MessageType.CAST_ADD) add(m.data.castAddBody?.parentCastId, 'reply_parent');
    for (const m of stores.reactions) if (m.data?.type === MessageType.REACTION_ADD) add(m.data.reactionBody?.targetCastId, 'reaction_target');
    let notFound = 0;
    let failed = 0;
    const hosts = new Set<string>();
    const errors: string[] = [];
    let i = 0;
    for (const [h, t] of targets) {
      if (interrupt.requested) break;
      if (++i % 500 === 0) log(`    context casts: ${i}/${targets.size}`);
      let msg: Message | null | undefined;
      for (const tr of transports) {
        if (down.has(tr)) continue;
        try {
          msg = await retry(() => tr.castById(t.fid, t.hash));
          hosts.add(tr.label);
          break;
        } catch (e) {
          if (errors.length < 5) errors.push(redact(`${tr.label}: ${errMessage(e)}`));
          markDown(tr, e);
        }
      }
      const reasons = [...t.reasons].sort();
      if (msg === undefined) {
        failed++;
        continue;
      }
      if (msg === null) {
        notFound++;
        contextCasts.push({ hash: h, fid: t.fid, found: false, reasons, source: 'protocol' });
        continue;
      }
      contextMsgs.push(msg);
      const r = castRecord(msg);
      const rec: ContextCastRecord = { hash: h, fid: t.fid, found: true, reasons, timestamp: r.timestamp, source: 'protocol', protocolHash: r.protocolHash };
      if (r.text !== undefined) rec.text = r.text;
      if (r.embeds) rec.embeds = r.embeds;
      if (r.parentCastId) rec.parentCastId = r.parentCastId;
      if (r.parentUrl) rec.parentUrl = r.parentUrl;
      contextCasts.push(rec);
    }
    entry.files = writeMessages('context-casts', contextMsgs);
    entry.host = [...hosts].join(', ') || null;
    entry.items = contextCasts.length;
    entry.pages = i;
    entry.notes = [`targets ${targets.size}; found ${contextMsgs.length}; not found (deleted or pruned) ${notFound}; lookups failed ${failed}`];
    if (errors.length) entry.fallbackErrors = errors;
    entry.status = interrupt.requested ? 'interrupted' : failed ? `error:${failed}-lookups-failed` : contextCasts.length ? 'complete' : 'empty';
    report(name);
  }

  const clientData: Record<string, unknown[] | null> = {};
  const profiles: Record<string, Record<string, unknown> | undefined> = {};
  // The whole /v2/user-by-fid bodies, for the account status (profiles keeps result.user only).
  const profileBodies: Record<string, unknown> = {};
  let priv: PrivateData | null = null;

  // Verbatim pages go to raw/client/<dir>/page-NNNN.json. Error bodies are saved redacted (a server could
  // echo the token in an error); 200 bodies are saved verbatim and caught by the token scan if one ever
  // echoed it.
  // An error that escapes one client source becomes that source's status, so the lane goes on to the next.
  const sourceException = (paginated: boolean, e: unknown): SourceEntry => ({ kind: 'client', host: client.currentBase, paginated, status: `error:exception:${safeErrorText(e, 200)}`, pages: 0, items: 0, lastCursorEmpty: paginated ? false : null, files: [] });
  const objectSource = async (name: string, path: string, params: Record<string, string | number>, o: { auth?: boolean; count?: (body: unknown) => number } = {}) => {
    laneAt.client = name;
    let entry: SourceEntry;
    let body: unknown;
    try {
      const r = await client.getObject(path, params, { auth: o.auth });
      const files: string[] = [];
      if (r.text !== undefined) {
        const ok = r.status === 'complete';
        const rel = `raw/client/${name}/${ok ? 'page' : 'error'}-0001.json`;
        writer.write(rel, ok ? r.text : redact(r.text.slice(0, 4000)));
        files.push(rel);
      }
      const n = r.status === 'complete' ? (o.count ? o.count(r.body) : 1) : 0;
      const status = r.status === 'complete' && o.count && n === 0 ? 'empty' : r.status;
      entry = { kind: 'client', host: r.base, paginated: false, status, pages: r.text !== undefined && r.status === 'complete' ? 1 : 0, items: n, lastCursorEmpty: null, files };
      body = r.body;
    } catch (e) {
      entry = sourceException(false, e);
    }
    S[`client:${name}`] = entry;
    report(`client:${name}`);
    return { entry, body };
  };
  const pagedSource = async (name: string, path: string, params: Record<string, string | number>, itemsKey: string, limit: number, o: { auth?: boolean; dir?: string; register?: boolean } = {}) => {
    laneAt.client = name;
    let entry: SourceEntry;
    let items: unknown[] = [];
    try {
      const r = await client.paginate(path, params, itemsKey, limit, { auth: o.auth });
      const dir = o.dir ?? name;
      const files = r.pages.map((p, i) => {
        const rel = `raw/client/${dir}/page-${pad(i + 1)}.json`;
        writer.write(rel, p);
        return rel;
      });
      if (r.errorBody !== undefined && r.status !== 'complete' && r.status !== 'empty') {
        const rel = `raw/client/${dir}/error-${pad(r.pages.length + 1)}.json`;
        writer.write(rel, redact(r.errorBody));
        files.push(rel);
      }
      entry = { kind: 'client', host: r.base, paginated: true, status: r.status, pages: r.pages.length, items: r.items.length, lastCursorEmpty: r.lastCursorEmpty, files, ...(r.limitUsed !== undefined ? { notes: [`limit=${r.limitUsed}`] } : {}) };
      items = r.items;
    } catch (e) {
      entry = sourceException(true, e);
    }
    if (o.register !== false) {
      S[`client:${name}`] = entry;
      report(`client:${name}`);
    }
    clientData[name] = finished(entry.status) ? items : null;
    return { entry, items };
  };
  // An endpoint whose answer shape is not documented (D19, D20): 200 pages verbatim, any other answer
  // redacted as an error file. Entries are counted by count; no shape is an error, and a 200 page with
  // no entries makes the source empty only when count could count it.
  const rawSource = async (name: string, path: string, params: Record<string, string | number>, o: { limit?: number; maxPages: number; count: (bodies: unknown[]) => number | null }) => {
    laneAt.client = name;
    let entry: SourceEntry;
    let count: number | null = null;
    const paginated = o.maxPages > 1;
    try {
      const r = await client.pagesRaw(path, params, { limit: o.limit, maxPages: o.maxPages });
      const files = r.pages.map((p, i) => {
        const rel = `raw/client/${name}/page-${pad(i + 1)}.json`;
        writer.write(rel, p);
        return rel;
      });
      if (r.errorBody !== undefined) {
        const rel = `raw/client/${name}/error-${pad(r.pages.length + 1)}.json`;
        writer.write(rel, redact(r.errorBody));
        files.push(rel);
      }
      if (r.status === 'complete') count = o.count(r.bodies);
      const status = r.status === 'complete' && count === 0 ? 'empty' : r.status;
      const notes = [...(r.bodies.length ? [shapeNote(r.bodies)] : []), ...(r.status === 'complete' && count === null ? ['entries not counted: no list directly under result; the pages are kept as they are'] : []), ...(r.note ? [redact(r.note)] : [])];
      entry = { kind: 'client', host: r.base, paginated, status, pages: r.pages.length, items: count ?? 0, lastCursorEmpty: paginated ? r.lastCursorEmpty : null, files, ...(notes.length ? { notes } : {}) };
    } catch (e) {
      entry = sourceException(paginated, e);
    }
    S[`client:${name}`] = entry;
    report(`client:${name}`);
    return { entry, count };
  };

  const clientLane = async () => {
    const object = (name: string, path: string, params: Record<string, string | number>) =>
      objectSource(name, path, params).then((r) => {
        profileBodies[name] = r.body;
        return r.body as { result?: { user?: Record<string, unknown> } } | undefined;
      });
    const paged = (name: string, path: string, params: Record<string, string | number>, itemsKey: string, limit: number) => pagedSource(name, path, params, itemsKey, limit);
    profiles.before = (await object('profile-before', '/v2/user-by-fid', { fid }))?.result?.user;
    if (opts.private) {
      writer.write('raw/client/me/page-0001.json', auth!.text!);
      S['client:me'] = { kind: 'client', host: auth!.base, paginated: false, status: 'complete', pages: 1, items: 1, lastCursorEmpty: null, files: ['raw/client/me/page-0001.json'], notes: ['GET /v2/me: the token check made before the run started'] };
      report('client:me');
      const helpers: CaptureHelpers = {
        paged: (o) => pagedSource(o.name, o.path, o.params, o.itemsKey, o.limit, { auth: true, dir: o.dir, register: o.register }),
        object: (o) => objectSource(o.name, o.path, o.params, { auth: true, count: o.count }),
        register: (name, entry) => {
          S[name] = entry;
          report(name);
        },
        raw: (o) => rawSource(o.name, o.path, o.params, { limit: o.limit, maxPages: o.maxPages, count: o.count }),
        ownFid: auth!.fid!,
        log,
        isInterrupted: () => interrupt.requested,
      };
      // Filled in place, so whatever was captured is kept if the lane stops partway.
      priv = emptyPrivateData();
      try {
        await capturePrivate(helpers, (b) => bookmarksReady(b), priv);
      } finally {
        bookmarksReady(null); // no-op when already resolved
      }
    }
    await paged('following', '/v2/following', { fid }, 'users', 50);
    await paged('followers', '/v2/followers', { fid }, 'users', 50);
    await paged('channels', '/v1/user-following-channels', { fid }, 'channels', 50);
    await paged('blocked-users', '/fc/blocked-users', { blockerFid: fid }, 'blockedUsers', 1000);
    profiles.after = (await object('profile-after', '/v2/user-by-fid', { fid }))?.result?.user;
  };

  let mediaRows: Awaited<ReturnType<typeof downloadMedia>> | null = null;
  const wantBookmarkMedia = scope.bookmarks && Boolean(opts.private);
  const mediaLane = async () => {
    const own = await castsPromise;
    const bookmarks = wantBookmarkMedia ? await bookmarksPromise : null;
    const refs: MediaRef[] = [];
    if (scope.own) refs.push(...own.map((r) => ({ ...r, origin: 'own' as const })));
    for (const b of bookmarks ?? []) {
      const hash = typeof b.hash === 'string' ? b.hash.toLowerCase() : '';
      for (const url of bookmarkMediaUrls(b)) refs.push({ url, castHash: hash, origin: 'bookmark' });
    }
    if (!scope.own && !wantBookmarkMedia) return;
    mediaRows = await downloadMedia(refs, writer, { fetchImpl: opts.mediaFetch, resolve: opts.mediaResolve, wait: opts.mediaWait, log });
  };

  const laneErrors: string[] = [];
  const failedLanes = new Set<string>();
  const guard = (lane: string, p: Promise<void>) => p.catch((e) => {
    failedLanes.add(lane);
    const msg = `${lane} lane failed${laneAt[lane] ? ` (last source started: ${laneAt[lane]})` : ''}: ${safeErrorText(e)}`;
    laneErrors.push(msg);
    log(`  ${msg}`);
  });
  // The protocol and media lanes wait for the bookmarks; resolve them even if the client lane fails.
  await Promise.all([guard('protocol', protocolLane()), guard('client', clientLane().finally(() => bookmarksReady(null))), guard('media', mediaLane())]);
  if (laneErrors.length) manifest.laneErrors = laneErrors;
  const storageAfter = await storageSource('after');

  // ---------- media index ----------
  if (scope.own || wantBookmarkMedia) {
    const m = mediaRows as Awaited<ReturnType<typeof downloadMedia>> | null;
    const rows = m?.rows ?? [];
    writer.writeJsonl('media/index.jsonl', rows);
    const stats = m?.stats ?? mediaStats([]);
    const origins: [MediaOrigin, string, boolean, string][] = [
      ['own', 'media:own', scope.own, S['protocol:casts']?.status ?? 'error:missing'],
      ['bookmark', 'media:bookmarks', wantBookmarkMedia, S['client:bookmarks']?.status ?? 'error:missing'],
    ];
    const byOrigin: Record<string, MediaStats> = {};
    for (const [origin, name, wanted, upstream] of origins) {
      if (!wanted) continue;
      const own = rows.filter((r: MediaIndexRow) => r.origins.includes(origin));
      const st = mediaStats(own);
      byOrigin[origin] = st;
      S[name] = {
        kind: 'media',
        host: null,
        paginated: false,
        status: m?.interrupted || interrupt.requested ? 'interrupted' : !finished(upstream) && !upstream.startsWith('unavailable') ? `error:${origin === 'own' ? 'casts' : 'bookmarks'}-unavailable` : st.urls ? 'complete' : 'empty',
        pages: st.urls,
        items: st.stored,
        lastCursorEmpty: null,
        files: ['media/index.jsonl'],
        notes: [`urls ${st.urls}; final status recorded ${st.withFinalStatus}; stored ${st.stored}; image urls ${st.imageUrls}; images stored ${st.imagesStored}`],
      };
      report(name);
    }
    manifest.media = { ...stats, byOrigin };
  }

  // ---------- graph sets ----------
  const follows = new Map<number, ProtoEdge>();
  const blocksP = new Map<number, ProtoEdge>();
  const removedAfter = new Map<string, number>();
  for (const m of stores.links) {
    const d = m.data;
    if (!d?.linkBody) continue;
    if (d.type === MessageType.LINK_REMOVE) removedAfter.set(`${d.linkBody.type}:${d.linkBody.targetFid}`, d.timestamp);
    if (d.type !== MessageType.LINK_ADD || d.linkBody.targetFid === undefined) continue;
    const edge = { fid: d.linkBody.targetFid, hash: toHex(m.hash), since: fcTimeToIso(d.linkBody.displayTimestamp || d.timestamp) };
    if (d.linkBody.type === 'follow') follows.set(edge.fid, edge);
    else if (d.linkBody.type === 'block') blocksP.set(edge.fid, edge);
  }
  const compactAll = [...compact, ...stores.links.filter((m) => m.data?.type === MessageType.LINK_COMPACT_STATE)];
  const compactSeen = new Set<string>();
  for (const m of compactAll) {
    const h = toHex(m.hash);
    if (compactSeen.has(h)) continue;
    compactSeen.add(h);
    const b = m.data?.linkCompactStateBody;
    if (!b || b.type !== 'follow') continue;
    for (const t of b.targetFids) {
      const rem = removedAfter.get(`follow:${t}`);
      if (follows.has(t) || (rem !== undefined && rem > m.data!.timestamp)) continue;
      follows.set(t, { fid: t, hash: h, since: fcTimeToIso(m.data!.timestamp) });
    }
  }
  const followersP = new Map<number, ProtoEdge>();
  for (const m of followerMsgs) {
    const d = m.data;
    if (d?.type !== MessageType.LINK_ADD || d.linkBody?.type !== 'follow') continue;
    if (!followersP.has(d.fid)) followersP.set(d.fid, { fid: d.fid, hash: toHex(m.hash), since: fcTimeToIso(d.linkBody.displayTimestamp || d.timestamp) });
  }

  const followingC = clientData.following ? clientEdges(clientData.following) : null;
  const followersC = clientData.followers ? clientEdges(clientData.followers) : null;
  const blocksC = clientData['blocked-users'] ? clientEdges(clientData['blocked-users'], 'blockedFid') : null;
  const profileUser = profiles.after ?? profiles.before;
  const clientProf = clientProfile(profileUser);
  const protoProf = protocolProfile(stores.userData);

  // ---------- normalized + csv ----------
  const following = mergeGraph(follows, followingC, fid, true);
  const followers = mergeGraph(followersP, followersC, fid, true);
  const blocks = mergeGraph(blocksP, blocksC, fid, false);
  const normalized: Record<string, unknown[]> = {
    casts: stores.casts.map(castRecord),
    reactions: stores.reactions.map(reactionRecord),
    links: [...stores.links, ...compact.filter((m) => !stores.links.some((x) => toHex(x.hash) === toHex(m.hash)))].map(linkRecord),
    following,
    followers,
    blocks,
    verifications: stores.verifications.map(verificationRecord),
    profile: [{ fid, protocol: protoProf.fields, protocolHashes: protoProf.hashes, client: clientProf, source: clientProf ? ['protocol', 'client'] : ['protocol'] }],
    'username-proofs': proofs.map(usernameProofRecord),
    signers: (events.signer ?? []).map(signerRecord).filter((x) => x !== null),
    'onchain-events': Object.values(events).flat().map(onChainEventRecord),
    storage: [storageBefore ? storageRecord('before', storageBefore.value) : null, storageAfter ? storageRecord('after', storageAfter.value) : null].filter((x) => x !== null),
    channels: (clientData.channels ?? []).map((c) => channelRecord(c as Record<string, unknown>)),
    'context-casts': contextCasts,
  };
  const pd = priv as PrivateData | null;
  let bookmarkRecords: BookmarkRecord[] = [];
  if (pd) {
    bookmarkRecords = pd.bookmarks.map((b, i) => bookmarkRecord(b, i + 1, bookmarkProtocol.get(typeof b.hash === 'string' ? b.hash.toLowerCase() : '')));
    normalized.bookmarks = bookmarkRecords;
    normalized['dm-conversations'] = pd.conversations.map(dmConversationRecord);
    normalized['dm-messages'] = pd.conversations.flatMap((c) => c.messages.map((m) => dmMessageRecord(c.conversationId, (m ?? {}) as Record<string, unknown>)));
    normalized.drafts = pd.drafts.map((d) => draftRecord((d ?? {}) as Record<string, unknown>));
    if (pd.mutedKeywords) normalized['muted-keywords'] = mutedKeywordList(pd.mutedKeywords).map((k) => ({ ...k, source: 'client' }));
    normalized['muted-users'] = pd.mutedUsers.map((u) => mutedUserRecord((u ?? {}) as Record<string, unknown>));
    if (pd.mutedChannels) normalized['muted-channels'] = pd.mutedChannels.map((c) => mutedChannelRecord((c ?? {}) as Record<string, unknown>));
    normalized['mini-apps'] = pd.miniApps.map((f) => miniAppRecord((f ?? {}) as Record<string, unknown>));
    manifest.directCasts = pd.conversations.map((c) => ({ index: c.index, conversationId: c.conversationId, categories: c.categories, dir: `raw/client/${c.dir}`, status: c.status, pages: c.pages, messages: c.messages.length, lastCursorEmpty: c.lastCursorEmpty, ...(c.limitUsed !== undefined ? { limitUsed: c.limitUsed } : {}) }));
  }
  // Schemas for exactly the normalized files written, so every file validates on its own (AC-15).
  for (const [name, records] of Object.entries(normalized)) {
    writer.writeJson(`normalized/${name}.json`, wrap(name, fid, records));
    writer.writeJson(`normalized/schemas/${name}.schema.json`, SCHEMAS[name]);
  }
  writer.writeJson('normalized/schemas/reconciliation.schema.json', RECONCILIATION_SCHEMA);

  const graphCsv = (rows: GraphRecord[]) => toCsv(['fid', 'username', 'display_name', 'since', 'protocol_hash', 'in_protocol', 'in_client_list', 'self_follow'], rows.map((r) => [r.fid, r.username, r.displayName, r.since, r.protocolHash, r.inProtocol, r.inClientList, r.selfFollow ?? '']));
  writer.write('csv/following.csv', graphCsv(following));
  writer.write('csv/followers.csv', graphCsv(followers));
  writer.write('csv/blocks.csv', graphCsv(blocks));
  writer.write('csv/channels.csv', toCsv(['channel_id', 'name', 'url', 'followed_at'], (normalized.channels as { id: string; name?: string; url?: string; followedAt?: number }[]).map((c) => [c.id, c.name, c.url, c.followedAt])));
  if (pd) {
    // One row per bookmark, link first (as in Mastodon's bookmarks export), then the cast itself.
    const embedUrls = (b: BookmarkRecord) => (b.embeds ?? []).map((e) => ('url' in e ? e.url : `cast:${e.castId.fid}:${e.castId.hash}`)).join(' ');
    writer.write('csv/bookmarks.csv', toCsv(['cast_url', 'hash', 'author_fid', 'author_username', 'timestamp', 'text', 'embeds', 'in_protocol', 'protocol_hash', 'position'], bookmarkRecords.map((b) => [bookmarkUrl(b), b.hash, b.fid, b.username, b.timestamp, b.text, embedUrls(b), b.inProtocol, b.protocolHash, b.position])));
  }

  // ---------- reconciliation ----------
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const recon = reconcile({
    fid,
    following: { protocol: follows, client: followingC, profileCount: num(profileUser?.followingCount) },
    followers: { protocol: followersP, client: followersC, profileCount: num(profileUser?.followerCount) },
    blocks: { protocol: blocksP, client: blocksC },
    profile: { protocol: protoProf.fields, client: clientProf },
  });
  writer.writeJson('reconciliation.json', recon);

  // ---------- datasets ----------
  const storeStatusNote = (store: Store): string[] => {
    const t = storeTransport[store];
    return t?.kind === 'http' && (store === 'reactions' || store === 'links') ? ['AC-13 gap unavailable:http-omits-removes (served by the HTTP API, which omits removes)'] : [];
  };
  // Sources a stopped lane never reached, for the summary.
  const notFetched = new Set<string>();
  const abortedIn = (sources: string[]) => {
    const a = laneAbortStatus(sources, (s) => Boolean(S[s]), failedLanes);
    for (const s of a?.missing ?? []) notFetched.add(s);
    return a;
  };
  const abortNote = (a: ReturnType<typeof laneAbortStatus>) => (a ? [`not fetched, the ${a.lane} lane stopped first: ${a.missing.join(', ')}`] : []);
  const ds = (id: string, name: string, sources: string[], count: number | null, extra: string[] = [], primary = sources[0]): void => {
    const srcs = sources.filter((s) => S[s]);
    const bad = srcs.find((s) => /^(error|interrupted)/.test(S[s].status));
    const p = S[primary];
    const aborted = abortedIn(sources);
    let status: string;
    if (bad && S[bad].status.startsWith('interrupted')) status = 'interrupted';
    else if (aborted) status = aborted.status;
    else if (bad) status = `error:${bad}`;
    else if (!p) status = 'error:primary-source-missing';
    else if (p.status.startsWith('unavailable')) status = p.status;
    else status = count ? 'complete' : 'empty';
    const paged = srcs.filter((s) => S[s].paginated);
    const notes = [...extra, ...abortNote(aborted), ...srcs.filter((s) => s !== primary && S[s].status.startsWith('unavailable')).map((s) => `${s} ${S[s].status}`)];
    manifest.datasets[id] = { name, status, count, sources: srcs, lastCursorEmpty: paged.length ? paged.every((s) => S[s].lastCursorEmpty === true) : null, notes };
  };
  const notRequested = (id: string, name: string) => (manifest.datasets[id] = { name, status: NOT_REQUESTED, count: null, sources: [], lastCursorEmpty: null, notes: ['private data: run with --private'] });
  // Every source is required: one that stopped early or errored makes the dataset an error, one that is
  // unavailable while others are not makes it a partial (error), and all unavailable makes it unavailable.
  const dsAll = (id: string, name: string, sources: string[], count: number, extra: string[] = []): void => {
    const st = sources.map((s) => [s, S[s]?.status ?? 'error:source-missing'] as const);
    const interrupted = st.find(([, x]) => x.startsWith('interrupted'));
    const bad = st.find(([, x]) => x.startsWith('error'));
    const unav = st.filter(([, x]) => x.startsWith('unavailable'));
    const aborted = abortedIn(sources);
    let status: string;
    if (interrupted) status = 'interrupted';
    else if (aborted) status = aborted.status;
    else if (bad) status = `error:${bad[0]}`;
    else if (unav.length === st.length) status = unav[0][1];
    else if (unav.length) status = `error:partial:${unav.map(([n, x]) => `${n}=${x}`).join(',')}`;
    else status = count ? 'complete' : 'empty';
    const srcs = sources.filter((s) => S[s]);
    const paged = srcs.filter((s) => S[s].paginated);
    manifest.datasets[id] = { name, status, count, sources: srcs, lastCursorEmpty: paged.length ? paged.every((s) => S[s].lastCursorEmpty === true) : null, notes: [...extra, ...abortNote(aborted)] };
  };

  ds('D1', 'following', ['protocol:links', 'client:following', 'protocol:link-compact-state'], follows.size, storeStatusNote('links'));
  ds('D2', 'followers', ['protocol:followers', 'client:followers'], followersP.size);
  // The private datasets follow --private, not what was captured: a --private run whose client lane
  // stopped reports errors, never "not requested".
  if (opts.private) ds('D3', 'bookmarks', ['client:bookmarks', 'protocol:bookmarked-casts'], bookmarkRecords.length, [S['protocol:bookmarked-casts']?.notes?.[0] ?? ''].filter(Boolean));
  else notRequested('D3', 'bookmarks');
  ds('D4', 'casts', ['protocol:casts'], stores.casts.length);
  ds('D5', 'reactions', ['protocol:reactions'], stores.reactions.length, storeStatusNote('reactions'));
  ds('D6', 'profile, username proofs, verifications', ['protocol:user-data', 'protocol:verifications', 'protocol:username-proofs', 'client:profile-before', 'client:profile-after'], stores.userData.length + stores.verifications.length + proofs.length);
  ds(
    'D7',
    'signers, on-chain events, storage',
    ['protocol:onchain-events-signer', 'protocol:onchain-events-signer-migrated', 'protocol:onchain-events-id-register', 'protocol:onchain-events-storage-rent', 'protocol:onchain-events-tier-purchase', 'protocol:onchain-signers-active', 'protocol:signers-by-fid', 'protocol:key-messages', 'protocol:storage-before', 'protocol:storage-after', 'protocol:storage-lends'],
    Object.values(events).flat().length + keyMessages.length + (storageBefore ? 1 : 0) + (storageAfter ? 1 : 0),
    [`gasless signers: ${S['protocol:signers-by-fid']?.notes?.at(-1) ?? 'signer list not fetched'}; KEY_ADD/KEY_REMOVE messages ${keyMessages.length} (protocol:key-messages ${S['protocol:key-messages']?.status})`],
  );
  ds('D8', 'blocks', ['protocol:links', 'client:blocked-users'], blocks.length);
  ds('D9', 'channel follows', ['client:channels'], (clientData.channels ?? []).length);
  if (opts.private) {
    const conversations = pd?.conversations ?? [];
    const messages = conversations.reduce((n, c) => n + c.messages.length, 0);
    dsAll('D10', 'direct casts', [...DM_CATEGORIES.map((c) => `client:dm-conversations-${c}`), 'client:dm-messages'], messages, [`conversations ${conversations.length}; messages ${messages}`]);
    ds('D11', 'drafts', ['client:drafts'], pd?.drafts.length ?? 0);
    ds('D12', 'muted keywords, users and channels', ['client:muted-keywords', 'client:muted-users', 'client:muted-channels'], (normalized['muted-keywords']?.length ?? 0) + (pd?.mutedUsers.length ?? 0) + (pd?.mutedChannels?.length ?? 0));
    ds('D13', 'favourite mini apps', ['client:favorite-mini-apps'], pd?.miniApps.length ?? 0);
  } else {
    notRequested('D10', 'direct casts');
    notRequested('D11', 'drafts');
    notRequested('D12', 'muted keywords, users and channels');
    notRequested('D13', 'favourite mini apps');
  }
  const mediaSources = [scope.own ? 'media:own' : '', wantBookmarkMedia ? 'media:bookmarks' : ''].filter(Boolean);
  const mediaNotes = [scope.bookmarks && !opts.private ? 'media of bookmarked casts needs --private' : '', opts.private && !scope.bookmarks ? 'media of bookmarked casts not requested (--media)' : ''].filter(Boolean);
  if (!mediaSources.length) manifest.datasets.D14 = { name: 'media', status: scope.bookmarks ? NOT_REQUESTED : 'unavailable:disabled-by-flag', count: null, sources: [], lastCursorEmpty: null, notes: [`--media ${opts.media}`, ...mediaNotes] };
  else ds('D14', `media (${[scope.own ? 'own casts' : '', wantBookmarkMedia ? 'bookmarked casts' : ''].filter(Boolean).join(' and ')})`, mediaSources, (manifest.media as MediaStats | undefined)?.urls ?? 0, mediaNotes);
  ds('D15', 'context casts', ['protocol:context-casts'], contextCasts.length);
  // D19 and D20 keep their source's status as it is (see INFO_DATASETS); a lane that stopped first
  // still shows as error:<lane>-lane-aborted.
  const infoDs = (id: string, name: string, source: string, count: number | null): void => {
    const s = S[source];
    const aborted = abortedIn([source]);
    manifest.datasets[id] = { name, status: aborted ? aborted.status : (s?.status ?? 'error:source-missing'), count: s && finished(s.status) ? count : null, sources: s ? [source] : [], lastCursorEmpty: s ? s.lastCursorEmpty : null, notes: [...(s?.notes ?? []), ...abortNote(aborted)] };
  };
  if (opts.private) {
    infoDs('D19', 'own moderation record', 'client:moderation-record', pd?.moderationRecord ?? null);
    infoDs('D20', 'stayed list', 'client:following-stayed', pd?.stayed ?? null);
  } else {
    notRequested('D19', 'own moderation record');
    notRequested('D20', 'stayed list');
  }

  manifest.counts = {
    following: recon.summary.following,
    followers: recon.summary.followers,
    blocks: recon.summary.blocks,
    stores: Object.fromEntries(
      (Object.keys(stores) as Store[]).map((s) => [
        STORE_LIMIT_NAME[s],
        { exported: stores[s].length, usedBefore: storageBefore?.value.limits.find((l) => l.name === STORE_LIMIT_NAME[s])?.used ?? null, usedAfter: storageAfter?.value.limits.find((l) => l.name === STORE_LIMIT_NAME[s])?.used ?? null, transport: storeTransport[s]?.label ?? null },
      ]),
    ),
    activeSignersReportedByNode: activeSigners.length,
    signersByFid: signerPages.length
      ? { onchain: signerPages.flatMap((p) => p.signers).filter((s) => s.source === SignerSource.ONCHAIN).length, gasless: signerPages.flatMap((p) => p.signers).filter((s) => s.source === SignerSource.OFFCHAIN).length, keyMessages: keyMessages.length }
      : null,
    profile: Object.fromEntries(Object.entries(profiles).map(([k, u]) => [k, u ? { followerCount: u.followerCount ?? null, followingCount: u.followingCount ?? null } : null])),
  };

  let meBody: unknown;
  try {
    meBody = auth?.text ? JSON.parse(auth.text) : undefined;
  } catch {}
  const picked = pickStatus({ after: profileBodies['profile-after'], before: profileBodies['profile-before'], me: meBody });
  const accountLine = statusLine(picked.fields, picked.from);
  manifest.accountStatus = {
    line: accountLine,
    source: `client:${picked.from}`,
    fields: { 'client:profile-before': statusFromProfile(profileBodies['profile-before']), 'client:profile-after': statusFromProfile(profileBodies['profile-after']), ...(opts.private ? { 'client:me': statusFromMe(meBody) } : {}) },
  };

  // ---------- seal ----------
  manifest.interrupted = interrupt.requested;
  manifest.finishedAt = now().toISOString();
  const errors = [...Object.entries(manifest.datasets).filter(([id, d]) => !INFO_DATASETS.has(id) && d.status.startsWith('error')).map(([, d]) => d), ...laneErrors];
  manifest.result = manifest.interrupted ? 'interrupted' : errors.length ? 'errors' : 'ok';
  // The token in use (--private) and any token in the environment are both scanned for.
  if (secrets.length) {
    const pre = scanTreeForSecrets(writer.root, secrets);
    manifest.tokenScan = { ran: true, filesScanned: pre.filesScanned, filesWithToken: pre.hits.length, note: `${token ? 'session token used by this run' : 'FC_SESSION_TOKEN (not used by this run)'}${token && envToken && envToken !== token ? ' and FC_SESSION_TOKEN' : ''}; covers every file except manifest.json and SHA256SUMS, which are scanned after sealing; that result is printed and sets the exit code` };
  } else {
    manifest.tokenScan = { ran: false, note: 'no session token: not a --private run and no FC_SESSION_TOKEN in the environment' };
  }
  writer.write('manifest.json', redact(JSON.stringify(manifest, null, 2)) + '\n');
  const files = writer.sealChecksums();
  let hits: string[] = [];
  if (secrets.length) hits = scanTreeForSecrets(writer.root, secrets).hits;

  for (const t of transports) t.close();

  const exitCode = hits.length ? 2 : manifest.interrupted ? 130 : errors.length ? 1 : 0;
  log(`Datasets: ${Object.entries(manifest.datasets).map(([id, d]) => `${id}=${d.status}`).join(' ')}`);
  log(accountLine);
  if (laneErrors.length) {
    log(`Lane errors: ${laneErrors.join('; ')}.${notFetched.size ? ` Not fetched: ${[...notFetched].join(', ')}.` : ''}`);
    log(`Result: ${manifest.result} (exit ${exitCode}). Re-run the export; see docs/USAGE.md.`);
  }
  log(`Files: ${files} (+SHA256SUMS). Verify with: node bin/castsnap.js verify "${writer.root}"`);
  if (transports.length && transports.every((t) => down.has(t))) {
    log(`Protocol data: every node failed (${transports.map((t) => t.label).join(', ')}). castsnap falls back only between Farcaster's own Snapchain nodes, which answer only on ports 3383 and 3381, so a network that allows only web traffic (port 443) cannot reach them. Run again later or from another network, or see --hub in docs/USAGE.md.`);
  }
  if (secrets.length) log(`Token self-scan: ${hits.length} file(s) contain the token${hits.length ? ' -- DELETE THIS FOLDER and report it' : ''}.`);
  return { dir: writer.root, exitCode, manifest };
}
