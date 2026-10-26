// Cross-source reconciliation (reconciliation.json). The protocol set is canonical (AC-10, AC-11); every
// difference from the client lists or profile is listed with a reason code from a closed set.

import type { GraphRecord } from './normalize.ts';
import { PROFILE_FIELDS } from './normalize.ts';
import type { ReasonCode } from './schemas.ts';
import { REASON_CODES } from './schemas.ts';

export interface ProtoEdge {
  fid: number;
  hash: string;
  since: string;
}
export interface ClientEdge {
  fid: number;
  username?: string;
  displayName?: string;
}

export interface ReconEntry {
  dataset: 'following' | 'followers' | 'blocks' | 'profile';
  reason: ReasonCode;
  fid?: number;
  field?: string;
  protocol?: unknown;
  client?: unknown;
  detail?: string;
}

export function clientEdges(items: unknown[], fidKey = 'fid'): ClientEdge[] {
  const out: ClientEdge[] = [];
  const seen = new Set<number>();
  for (const it of items) {
    const o = (it ?? {}) as Record<string, unknown>;
    const fid = Number(o[fidKey]);
    if (!Number.isInteger(fid) || seen.has(fid)) continue;
    seen.add(fid);
    out.push({ fid, username: typeof o.username === 'string' ? o.username : undefined, displayName: typeof o.displayName === 'string' ? o.displayName : undefined });
  }
  return out;
}

// Union of the protocol set and the client list, one record per fid, protocol order first.
export function mergeGraph(protocol: Map<number, ProtoEdge>, client: ClientEdge[] | null, selfFid: number, markSelf: boolean): GraphRecord[] {
  const byFid = new Map((client ?? []).map((c) => [c.fid, c]));
  const out: GraphRecord[] = [];
  for (const [fid, e] of protocol) {
    const c = byFid.get(fid);
    const rec: GraphRecord = { fid, since: e.since, protocolHash: e.hash, inProtocol: true, inClientList: Boolean(c), source: c ? ['protocol', 'client'] : ['protocol'] };
    if (c?.username) rec.username = c.username;
    if (c?.displayName) rec.displayName = c.displayName;
    if (markSelf) rec.selfFollow = fid === selfFid;
    out.push(rec);
  }
  for (const c of client ?? []) {
    if (protocol.has(c.fid)) continue;
    const rec: GraphRecord = { fid: c.fid, inProtocol: false, inClientList: true, source: ['client'] };
    if (c.username) rec.username = c.username;
    if (c.displayName) rec.displayName = c.displayName;
    if (markSelf) rec.selfFollow = c.fid === selfFid;
    out.push(rec);
  }
  return out;
}

export const followersTolerance = (clientListSize: number): number => Math.max(2, 0.005 * clientListSize);

export interface ReconInput {
  fid: number;
  following: { protocol: Map<number, ProtoEdge>; client: ClientEdge[] | null; profileCount: number | null };
  followers: { protocol: Map<number, ProtoEdge>; client: ClientEdge[] | null; profileCount: number | null };
  blocks: { protocol: Map<number, ProtoEdge>; client: ClientEdge[] | null };
  profile: { protocol: Record<string, string>; client: Record<string, string | number> | null };
}

export function reconcile(input: ReconInput) {
  const entries: ReconEntry[] = [];
  const { fid } = input;

  const diffGraph = (dataset: 'following' | 'followers' | 'blocks', protocol: Map<number, ProtoEdge>, client: ClientEdge[] | null) => {
    if (!client) return { protocolOnly: null, clientOnly: null };
    const clientSet = new Set(client.map((c) => c.fid));
    let protocolOnly = 0;
    let clientOnly = 0;
    for (const p of protocol.keys()) {
      if (clientSet.has(p)) continue;
      protocolOnly++;
      entries.push({ dataset, reason: dataset !== 'blocks' && p === fid ? 'self_follow' : 'hidden_by_client', fid: p });
    }
    for (const c of clientSet) {
      if (protocol.has(c)) continue;
      clientOnly++;
      entries.push({ dataset, reason: 'client_only', fid: c });
    }
    return { protocolOnly, clientOnly };
  };

  const f = input.following;
  const selfFollow = f.protocol.has(fid);
  const followingExSelf = f.protocol.size - (selfFollow ? 1 : 0);
  const fDiff = diffGraph('following', f.protocol, f.client);
  if (f.profileCount !== null && followingExSelf !== f.profileCount) {
    entries.push({ dataset: 'following', reason: 'count_mismatch', protocol: followingExSelf, client: f.profileCount, detail: 'protocol following count excluding self-follow vs profile followingCount' });
  }

  const r = input.followers;
  const rDiff = diffGraph('followers', r.protocol, r.client);
  const b = input.blocks;
  const bDiff = diffGraph('blocks', b.protocol, b.client);

  const mismatches: string[] = [];
  if (input.profile.client) {
    for (const field of PROFILE_FIELDS) {
      const p = input.profile.protocol[field] ?? '';
      const c = String(input.profile.client[field] ?? '');
      if (p !== c) {
        mismatches.push(field);
        entries.push({ dataset: 'profile', reason: 'profile_field_mismatch', field, protocol: p, client: c });
      }
    }
  }

  const summary = {
    following: {
      protocol: f.protocol.size,
      selfFollow,
      protocolExcludingSelf: followingExSelf,
      clientList: f.client?.length ?? null,
      profileFollowingCount: f.profileCount,
      countMatchesProfile: f.profileCount === null ? null : followingExSelf === f.profileCount,
      ...fDiff,
    },
    followers: {
      protocol: r.protocol.size,
      clientList: r.client?.length ?? null,
      profileFollowerCount: r.profileCount,
      ...rDiff,
      clientOnlyTolerance: r.client ? followersTolerance(r.client.length) : null,
    },
    blocks: { protocol: b.protocol.size, clientList: b.client?.length ?? null, ...bDiff },
    profile: { fieldsCompared: [...PROFILE_FIELDS], clientAvailable: Boolean(input.profile.client), mismatches },
    entriesByReason: Object.fromEntries(REASON_CODES.map((code) => [code, entries.filter((e) => e.reason === code).length])),
  };

  return { schemaVersion: 1 as const, fid, reasonCodes: [...REASON_CODES], summary, entries };
}
