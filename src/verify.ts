// castsnap verify DIR: offline checks of a finished export against the automatable acceptance criteria.
// Reads only the export directory; makes no network requests. The full message validation is run
// with no RPC clients, because @farcaster/core's default would call public RPC nodes for
// contract-wallet verification claims.

import fs from 'node:fs';
import path from 'node:path';
import {
  decodeGaslessSignedKeyRequestMetadata,
  HashScheme,
  IdRegisterEventType,
  Message,
  MessageData,
  MessageType,
  OnChainEvent,
  SignerEventType,
  SignersByFidResponse,
  SignerSource,
  StorageLimitsResponse,
  validations,
  verifyKeyAdd,
} from '@farcaster/core';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseCsv } from './csv.ts';
import { FARCASTER_EPOCH_S, type KeyEvent, type KeyUse, keyOf, messageData, shortKey, walkGaslessKey } from './gasless.ts';
import { PROFILE_FIELDS } from './normalize.ts';
import { checkOwnerOnly, type OsDeps, osDeps, readWindowsAcls } from './permissions.ts';
import { followersTolerance } from './reconcile.ts';
import { scanTreeForSecret, tokenFromEnv } from './secrets.ts';
import { pickStatus, recordCounts, statusLine } from './status.ts';
import { decodeDelimited, listExportFiles, sha256File, SUMS_FILE } from './writer.ts';
import { fcTimeToIso, tally, toHex } from './util.ts';
import type { Manifest } from './export.ts';

// INFO: shown, never graded, never changes the exit code (the STATUS line).
export type Verdict = 'PASS' | 'FAIL' | 'N/A' | 'INFO';
export interface Check {
  id: string;
  verdict: Verdict;
  detail: string[];
  // Parts of the criterion only the user can check (spot checks in the app). The verdict covers the
  // automatable parts only; these are printed as instructions.
  manual?: string[];
}

const OWN_MESSAGE_FILES = ['casts', 'reactions', 'links', 'user-data', 'verifications', 'storage-lends', 'link-compact-state'];
const OTHER_MESSAGE_FILES = ['followers', 'context-casts', 'bookmarked-casts'];
const KEY_MESSAGE_FILE = 'key-messages';
const KEY_USE_REASON: Record<Exclude<KeyUse, 'authorized'>, string> = {
  'no-key-add': 'no valid exported KEY_ADD of its key at or before it',
  removed: 'its key was removed by a KEY_REMOVE before it',
  'out-of-scope': 'its message type is not in the KEY_ADD scopes',
  expired: 'later than the key\'s last use + TTL',
};
const DM_CATEGORIES = ['default', 'archived', 'request', 'void'];
const HEX_HASH = /^0x[0-9a-f]+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Verbatim client pages of one source directory, in page order, independent of castsnap's normalization.
function rawPages(dir: string): { files: string[]; bodies: { result?: Record<string, unknown>; next?: { cursor?: string } }[]; errors: string[] } {
  if (!fs.existsSync(dir)) return { files: [], bodies: [], errors: [] };
  const names = fs.readdirSync(dir).sort();
  const files = names.filter((f) => /^page-\d{4}\.json$/.test(f));
  return { files, bodies: files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))), errors: names.filter((f) => /^error-\d{4}\.json$/.test(f)) };
}
const lastCursorEmpty = (bodies: { next?: { cursor?: string } }[]) => bodies.length > 0 && !bodies[bodies.length - 1].next?.cursor;
const DATASET_IDS = Array.from({ length: 15 }, (_, i) => `D${i + 1}`);
// The own moderation record and the stayed list (D19, D20): information, never graded.
const INFO_SOURCES = new Set(['client:moderation-record', 'client:following-stayed']);

const okStatus = (s: string) => /^(complete|empty|unavailable:.+)$/.test(s);
const finished = (s: string | undefined) => s === 'complete' || s === 'empty';

export async function verifyExport(dir: string, opts: { env?: NodeJS.ProcessEnv; progress?: (s: string) => void; os?: Partial<OsDeps> } = {}): Promise<{ checks: Check[]; exitCode: number }> {
  const root = path.resolve(dir);
  const checks: Check[] = [];
  const add = (id: string, verdict: Verdict, detail: string[], manual?: string[]) => checks.push({ id, verdict, detail, ...(manual ? { manual } : {}) });
  const p = (rel: string) => path.join(root, rel);
  const exists = (rel: string) => fs.existsSync(p(rel));
  const readJson = <T>(rel: string): T => JSON.parse(fs.readFileSync(p(rel), 'utf8'));

  if (!exists('manifest.json')) {
    add('AC-01', 'FAIL', ['manifest.json missing']);
    return { checks, exitCode: 1 };
  }
  const m = readJson<Manifest>('manifest.json');
  const fid = m.fid;
  const isPrivate = m.options?.private === true;
  const records = <T>(name: string): T[] | null => (exists(`normalized/${name}.json`) ? readJson<{ records: T[] }>(`normalized/${name}.json`).records : null);

  // ---------- AC-01 ----------
  {
    const missing = DATASET_IDS.filter((id) => !m.datasets[id]);
    const bad = DATASET_IDS.filter((id) => m.datasets[id] && !okStatus(m.datasets[id].status));
    // D19 and D20 are information, so they are not in these counts.
    const counts = tally(Object.entries(m.datasets).filter(([id]) => DATASET_IDS.includes(id)).map(([, d]) => d), (d) => d.status.split(':')[0]);
    const unavailable = DATASET_IDS.filter((id) => m.datasets[id]?.status.startsWith('unavailable')).map((id) => `${id}=${m.datasets[id].status}`);
    add('AC-01', missing.length || bad.length || m.result !== 'ok' ? 'FAIL' : 'PASS', [
      `datasets D1-D15 present: ${DATASET_IDS.length - missing.length}/15${missing.length ? ' missing ' + missing.join(',') : ''}`,
      `status counts: ${JSON.stringify(counts)}; error: ${bad.length}${bad.length ? ' (' + bad.map((id) => `${id}=${m.datasets[id].status}`).join(', ') + ')' : ''}`,
      `unavailable: ${unavailable.join(', ') || 'none'}`,
      `manifest result: ${m.result}`,
      `lane errors: ${m.laneErrors?.length ? m.laneErrors.join('; ') : 'none'}`,
    ]);
  }

  // ---------- AC-02 ----------
  {
    // Sources the run had no endpoint for (unavailable:*) were never paginated; AC-01 reports them. The
    // own moderation record and the stayed list are information (the STATUS line), not graded here.
    const all = Object.entries(m.sources).filter(([n, s]) => s.paginated && !INFO_SOURCES.has(n));
    const info = Object.entries(m.sources).filter(([n]) => INFO_SOURCES.has(n));
    const skipped = all.filter(([, s]) => s.status.startsWith('unavailable'));
    const paged = all.filter(([, s]) => !s.status.startsWith('unavailable'));
    const notEnded = paged.filter(([, s]) => s.lastCursorEmpty !== true);
    const ends = tally(paged, ([, s]) => s.end ?? (s.kind === 'client' ? 'empty-cursor' : 'unknown'));
    add('AC-02', paged.length && !notEnded.length ? 'PASS' : 'FAIL', [
      `paginated sources: ${paged.length}; final page had an empty cursor/token: ${paged.length - notEnded.length}`,
      `end reasons: ${JSON.stringify(ends)}`,
      ...notEnded.map(([n, s]) => `not ended: ${n} status=${s.status}`),
      ...(skipped.length ? [`not paginated (unavailable): ${skipped.map(([n, s]) => `${n}=${s.status}`).join(', ')}`] : []),
      ...(info.length ? [`information, not graded: ${info.map(([n, s]) => `${n}=${s.status}`).join(', ')}`] : []),
    ]);
  }

  // ---------- AC-03 ----------
  {
    const detail: string[] = [];
    let fail = false;
    if (!exists(SUMS_FILE)) {
      add('AC-03', 'FAIL', ['SHA256SUMS missing']);
    } else {
      const listed = new Map<string, string>();
      for (const line of fs.readFileSync(p(SUMS_FILE), 'utf8').split('\n')) {
        if (!line) continue;
        const mm = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
        if (!mm) {
          fail = true;
          detail.push(`malformed line: ${line.slice(0, 80)}`);
          continue;
        }
        listed.set(mm[2], mm[1]);
      }
      let mismatches = 0;
      let missing = 0;
      for (const [rel, sum] of listed) {
        if (!exists(rel)) {
          missing++;
          continue;
        }
        if (sha256File(p(rel)) !== sum) mismatches++;
      }
      const { files, irregular } = listExportFiles(root);
      const unlisted = files.filter((f) => f !== SUMS_FILE && !listed.has(f));
      fail ||= mismatches > 0 || missing > 0 || unlisted.length > 0 || irregular.length > 0;
      detail.unshift(`files listed ${listed.size}; recomputed ${listed.size - missing}; mismatches ${mismatches}; missing ${missing}; unlisted ${unlisted.length}; non-regular entries ${irregular.length}`);
      for (const u of [...unlisted, ...irregular].slice(0, 5)) detail.push(`unexpected: ${u}`);
      add('AC-03', fail ? 'FAIL' : 'PASS', detail);
    }
  }

  // ---------- AC-04 ----------
  {
    const signerAdds = new Set<string>();
    const signerRemoves = new Set<string>();
    if (exists('raw/protocol/onchain-events-signer.pb')) {
      for (const b of decodeDelimited(fs.readFileSync(p('raw/protocol/onchain-events-signer.pb')))) {
        const e = OnChainEvent.decode(b);
        const k = toHex(e.signerEventBody?.key);
        if (e.signerEventBody?.eventType === SignerEventType.ADD) signerAdds.add(k);
        if (e.signerEventBody?.eventType === SignerEventType.REMOVE) signerRemoves.add(k);
      }
    }
    // Custody address over time, from the exported ID-registry events: a register or transfer sets it.
    const custody: { at: number; to: Uint8Array }[] = [];
    if (exists('raw/protocol/onchain-events-id-register.pb')) {
      const evs = decodeDelimited(fs.readFileSync(p('raw/protocol/onchain-events-id-register.pb'))).map((b) => OnChainEvent.decode(b));
      evs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
      for (const e of evs) {
        const t = e.idRegisterEventBody?.eventType;
        if (t === IdRegisterEventType.REGISTER || t === IdRegisterEventType.TRANSFER) custody.push({ at: e.blockTimestamp, to: e.idRegisterEventBody!.to });
      }
    }
    const custodyAt = (unix: number) => custody.filter((c) => c.at <= unix).at(-1)?.to;

    const stats = { total: 0, hashOk: 0, sigOk: 0, own: 0, ownFidOk: 0, signerInAddEvents: 0, signerLaterRemoved: 0, fullValidationOk: 0 };
    const fullFailures: string[] = [];
    const hashSigFailures: string[] = [];
    const perFile: string[] = [];
    // Own messages whose signer has no on-chain ADD event, for the gasless check; and the key messages.
    type OwnUse = { file: string; hash: string; type: number; ts: number; signer: string };
    const gaslessUses: OwnUse[] = [];
    const keyMsgs: { msg: Message; data: MessageData; ok: boolean }[] = [];
    let done = 0;
    const roles = [...OWN_MESSAGE_FILES.map((f) => [f, 'own'] as const), ...OTHER_MESSAGE_FILES.map((f) => [f, 'other'] as const), [KEY_MESSAGE_FILE, 'key'] as const];
    for (const [file, role] of roles) {
      const rel = `raw/protocol/${file}.pb`;
      if (!exists(rel)) continue;
      const items = decodeDelimited(fs.readFileSync(p(rel)));
      let fileOk = 0;
      for (const b of items) {
        const msg = Message.decode(b);
        stats.total++;
        const bytes = msg.dataBytes && msg.dataBytes.length ? msg.dataBytes : msg.data ? MessageData.encode(msg.data).finish() : new Uint8Array();
        const h = await validations.createMessageHash(bytes, HashScheme.BLAKE3);
        const hashOk = h.isOk() && Buffer.compare(Buffer.from(h.value), Buffer.from(msg.hash)) === 0;
        const s = await validations.verifySignedMessageHash(msg.hash, msg.signature, msg.signer);
        const sigOk = s.isOk() && s.value === true;
        if (hashOk) stats.hashOk++;
        if (sigOk) stats.sigOk++;
        if (hashOk && sigOk) fileOk++;
        else if (hashSigFailures.length < 10) hashSigFailures.push(`${file} ${toHex(msg.hash)} hashOk=${hashOk} sigOk=${sigOk}`);
        const data = messageData(msg);
        if (role === 'own') {
          stats.own++;
          if (data?.fid === fid) stats.ownFidOk++;
          const signer = toHex(msg.signer);
          if (signerAdds.has(signer)) stats.signerInAddEvents++;
          else gaslessUses.push({ file, hash: toHex(msg.hash), type: data?.type ?? 0, ts: data?.timestamp ?? 0, signer });
          if (signerRemoves.has(signer)) stats.signerLaterRemoved++;
        }
        if (role === 'key' && data) keyMsgs.push({ msg, data, ok: hashOk && sigOk });
        const full = await validations.validateMessage(msg, undefined, {});
        if (full.isOk()) stats.fullValidationOk++;
        else fullFailures.push(full.error.message.replace(/Expected=.*$/, '').slice(0, 80));
        if (++done % 5000 === 0) opts.progress?.(`  AC-04: ${done} messages checked`);
      }
      perFile.push(`${file} ${fileOk}/${items.length}`);
    }

    // (c) for keys without an on-chain ADD event: the exported KEY_ADDs that pass (a) and whose custody
    // signature recovers to the custody address at their time, the KEY_REMOVEs, and the sliding-TTL walk.
    const ka = { total: 0, valid: 0, failedA: 0, noCustody: 0, badCustody: 0, otherFid: 0, envelopeIsKey: 0, removes: 0 };
    const keyEvents = new Map<string, KeyEvent<number>[]>();
    const invalidAdds = new Map<string, string[]>();
    const requestFids = new Set<string>();
    const push = (k: string, e: KeyEvent<number>) => {
      if (!keyEvents.has(k)) keyEvents.set(k, []);
      keyEvents.get(k)!.push(e);
    };
    for (const { msg, data, ok } of keyMsgs) {
      if (data.fid !== fid) {
        ka.otherFid++;
        continue;
      }
      const key = keyOf(data);
      if (data.type === MessageType.KEY_REMOVE) {
        ka.removes++;
        push(key, { kind: 'remove', ts: data.timestamp });
        continue;
      }
      if (data.type !== MessageType.KEY_ADD || !data.keyAddBody) continue;
      ka.total++;
      const b = data.keyAddBody;
      if (toHex(msg.signer) === key) ka.envelopeIsKey++;
      const meta = decodeGaslessSignedKeyRequestMetadata(b.metadata);
      if (meta.isOk()) requestFids.add(String(meta.value.requestFid));
      const invalid = (why: string) => invalidAdds.set(key, [...(invalidAdds.get(key) ?? []), why]);
      if (!ok) {
        ka.failedA++;
        invalid('fails hash/signature');
        continue;
      }
      const addr = custodyAt(data.timestamp + FARCASTER_EPOCH_S);
      if (!addr) {
        ka.noCustody++;
        invalid('no custody address known at its time');
        continue;
      }
      const r = await verifyKeyAdd({ fid: BigInt(fid), key: b.key, keyType: b.keyType, scopes: b.scopes, ttl: b.ttl, nonce: b.nonce, deadline: BigInt(b.deadline) }, b.custodySignature, addr);
      if (!(r.isOk() && r.value === true)) {
        ka.badCustody++;
        invalid('custody signature does not recover to the custody address at its time');
        continue;
      }
      ka.valid++;
      push(key, { kind: 'add', ts: data.timestamp, scopes: b.scopes, ttl: b.ttl });
    }
    gaslessUses.forEach((u, i) => push(u.signer, { kind: 'use', ts: u.ts, type: u.type, ref: i }));
    const uses = new Map<number, KeyUse>();
    for (const evs of keyEvents.values()) for (const [i, r] of walkGaslessKey(evs)) uses.set(i, r);
    const gaslessOk = gaslessUses.filter((_, i) => uses.get(i) === 'authorized');
    const notAuthorized = gaslessUses.map((u, i) => ({ u, r: uses.get(i) ?? 'no-key-add' })).filter((x) => x.r !== 'authorized');
    const authorized = stats.signerInAddEvents + gaslessOk.length;
    const perKey = Object.entries(tally(gaslessOk, (u) => shortKey(u.signer))).map(([k, n]) => `${k} ${n} (${Object.entries(tally(gaslessOk.filter((u) => shortKey(u.signer) === k), (u) => MessageType[u.type] ?? u.type)).map(([t, c]) => `${t} ${c}`).join(', ')})`);

    const listed = exists('raw/protocol/signers-by-fid.pb') ? decodeDelimited(fs.readFileSync(p('raw/protocol/signers-by-fid.pb'))).flatMap((b) => SignersByFidResponse.decode(b).signers) : null;
    const listedGasless = (listed ?? []).filter((s) => s.source === SignerSource.OFFCHAIN).map((s) => toHex(s.key));
    const withKeyAdd = new Set(keyMsgs.filter((k) => k.data.type === MessageType.KEY_ADD).map((k) => keyOf(k.data)));

    const pass = stats.total > 0 && stats.hashOk === stats.total && stats.sigOk === stats.total && stats.ownFidOk === stats.own && authorized === stats.own;
    add('AC-04', pass ? 'PASS' : 'FAIL', [
      `messages ${stats.total}: blake3 hash OK ${stats.hashOk}, ed25519 signature OK ${stats.sigOk}`,
      `per file (hash+signature OK/total): ${perFile.join(', ')}`,
      `own messages ${stats.own}: fid=${fid} ${stats.ownFidOk}; signer authorized ${authorized}: by an on-chain SIGNER ADD event ${stats.signerInAddEvents}, by a gasless KEY_ADD ${gaslessOk.length}; not authorized ${stats.own - authorized} (signer keys with ADD events: ${signerAdds.size}; own messages whose signer also has an on-chain REMOVE event: ${stats.signerLaterRemoved})`,
      `gasless keys: KEY_ADD ${ka.total}, valid ${ka.valid} (custody signature checked against the custody address at its time, from ${custody.length} ID-registry register/transfer event(s)); KEY_REMOVE ${ka.removes}${ka.otherFid ? `; key messages for other fids ${ka.otherFid}` : ''}; own messages authorized per key: ${perKey.join('; ') || 'none'}`,
      ...[...invalidAdds].map(([k, why]) => `invalid KEY_ADD for key ${shortKey(k)}: ${Object.entries(tally(why, (x) => x)).map(([w, n]) => `${w} (${n})`).join(', ')}`),
      ...notAuthorized.slice(0, 10).map(({ u, r }) => `not authorized: ${u.file} ${MessageType[u.type] ?? u.type} ${u.hash} signer ${shortKey(u.signer)} at ${fcTimeToIso(u.ts)}: ${KEY_USE_REASON[r as Exclude<KeyUse, 'authorized'>]}`),
      ...(notAuthorized.length > 10 ? [`not authorized: ${notAuthorized.length - 10} more`] : []),
      listed
        ? `info: signersByFid lists ${listed.length - listedGasless.length} on-chain and ${listedGasless.length} gasless key(s) (expired gasless keys stay listed); gasless keys with an exported KEY_ADD ${listedGasless.filter((k) => withKeyAdd.has(k)).length}/${listedGasless.length}; KEY_ADD envelope signed by the added key ${ka.envelopeIsKey}/${ka.total}${requestFids.size ? `; requested by app fid ${[...requestFids].join(', ')}` : ''}`
        : 'info: no signers-by-fid.pb: this export predates gasless signer support, so only on-chain signer events can authorize',
      `info: full core.validateMessage (offline, no RPC clients) OK ${stats.fullValidationOk}/${stats.total}${fullFailures.length ? '; not OK ' + JSON.stringify(tally(fullFailures, (x) => x)) : ''}${fullFailures.some((x) => /RPC client not provided/.test(x)) ? ' (contract-wallet claims need an RPC node, so they are not checkable offline)' : ''}`,
      'scope: checks (b) and (c) apply to the FID\'s own messages; followers, context casts and bookmarked casts are fetched for context and get check (a) only; KEY_ADD and KEY_REMOVE messages get check (a) and are the evidence for (c)',
      ...hashSigFailures,
    ]);
  }

  // ---------- AC-10 / AC-11 ----------
  const recon = exists('reconciliation.json') ? readJson<{ summary: Record<string, Record<string, unknown>>; entries: { dataset: string; reason: string; fid?: number }[] }>('reconciliation.json') : null;
  const graph = (name: string) => (exists(`normalized/${name}.json`) ? readJson<{ records: { fid: number; inProtocol: boolean; inClientList: boolean }[] }>(`normalized/${name}.json`).records : []);
  if (!recon) {
    add('AC-10', 'FAIL', ['reconciliation.json missing']);
    add('AC-11', 'FAIL', ['reconciliation.json missing']);
  } else {
    const f = recon.summary.following;
    const fe = recon.entries.filter((e) => e.dataset === 'following');
    const protocolOnly = graph('following').filter((r) => r.inProtocol && !r.inClientList).map((r) => r.fid);
    const listed = new Set(fe.filter((e) => e.reason === 'hidden_by_client' || e.reason === 'self_follow').map((e) => e.fid));
    const a = f.profileFollowingCount !== null && f.protocolExcludingSelf === f.profileFollowingCount;
    const b = f.clientList !== null && f.clientOnly === 0;
    const c = f.clientList !== null && protocolOnly.every((x) => listed.has(x)) && listed.size === protocolOnly.length;
    add('AC-10', a && b && c ? 'PASS' : 'FAIL', [
      `(a) protocol following ${f.protocol}, self-follow ${f.selfFollow}, excluding self ${f.protocolExcludingSelf} vs profile followingCount ${f.profileFollowingCount}: ${a ? 'equal' : 'NOT equal'}`,
      `(b) client /v2/following list ${f.clientList}; client-only ${f.clientOnly}: ${b ? 'ok' : 'FAIL'}`,
      `(c) protocol-only ${protocolOnly.length}; listed in reconciliation.json as hidden_by_client/self_follow ${listed.size}: ${c ? 'ok' : 'FAIL'}`,
    ]);

    const r = recon.summary.followers;
    const src = m.sources['protocol:followers'];
    const cli = m.sources['client:followers'];
    const re = recon.entries.filter((e) => e.dataset === 'followers' && e.reason === 'client_only');
    const tol = typeof r.clientList === 'number' ? followersTolerance(r.clientList) : null;
    const a2 = Boolean(src?.lastCursorEmpty) && (src?.end === 'empty-token' || src?.end === 'all-null-shard-token');
    const b2 = Boolean(cli?.lastCursorEmpty) && (cli?.status === 'complete' || cli?.status === 'empty');
    const c2 = tol !== null && typeof r.clientOnly === 'number' && r.clientOnly <= tol && re.length === r.clientOnly;
    const counts = m.counts.followers as Record<string, unknown> | undefined;
    const d2 = typeof counts?.protocol === 'number' && typeof counts?.profileFollowerCount === 'number';
    add('AC-11', a2 && b2 && c2 && d2 ? 'PASS' : 'FAIL', [
      `(a) protocol followers pagination end: ${src?.end} (pages ${src?.pages}, messages ${src?.items}): ${a2 ? 'ok' : 'FAIL'}`,
      `(b) client /v2/followers: status ${cli?.status}, pages ${cli?.pages}, items ${cli?.items}, last cursor empty ${cli?.lastCursorEmpty}: ${b2 ? 'ok' : 'FAIL'}`,
      `(c) client-only ${r.clientOnly} <= max(2, 0.5% of ${r.clientList}) = ${tol}; listed as client_only ${re.length}: ${c2 ? 'ok' : 'FAIL'}`,
      `(d) manifest counts: protocol ${counts?.protocol}, app profile followerCount ${counts?.profileFollowerCount}, client list ${counts?.clientList}: ${d2 ? 'ok' : 'FAIL'}`,
    ]);
  }

  // ---------- AC-13 ----------
  {
    const used = (phase: string): Record<string, number> | null => {
      const rel = `raw/protocol/storage-${phase}.pb`;
      if (!exists(rel)) return null;
      return Object.fromEntries(StorageLimitsResponse.decode(fs.readFileSync(p(rel))).limits.map((l) => [l.name, l.used]));
    };
    const before = used('before');
    const after = used('after');
    const count = (file: string) => (exists(`raw/protocol/${file}.pb`) ? decodeDelimited(fs.readFileSync(p(`raw/protocol/${file}.pb`))).length : null);
    const rows: [string, string, string, boolean][] = [
      ['CASTS', 'casts', 'protocol:casts', true],
      ['REACTIONS', 'reactions', 'protocol:reactions', true],
      ['LINKS', 'links', 'protocol:links', true],
      ['USER_DATA', 'user-data', 'protocol:user-data', false],
      ['VERIFICATIONS', 'verifications', 'protocol:verifications', false],
      ['STORAGE_LENDS', 'storage-lends', 'protocol:storage-lends', false],
    ];
    let pass = Boolean(before && after);
    const detail: string[] = [];
    for (const [store, file, source, required] of rows) {
      const n = count(file);
      const ub = before?.[store];
      const ua = after?.[store];
      const viaHttp = /^https?:/.test(m.sources[source]?.host ?? '');
      const eq = n !== null && n === ub && n === ua;
      const gap = viaHttp && (store === 'REACTIONS' || store === 'LINKS') ? ' unavailable:http-omits-removes' : '';
      if (required && (!eq || gap)) pass = false;
      detail.push(`${store.padEnd(13)} exported ${n} · used before ${ub} · used after ${ua} · ${eq ? 'EQUAL' : 'DIFF'}${gap}${required ? '' : ' (info)'}`);
    }
    const proofs = exists('normalized/username-proofs.json') ? readJson<{ records: { type: string }[] }>('normalized/username-proofs.json').records : [];
    detail.push(`USERNAME_PROOFS used before ${before?.USERNAME_PROOFS} · after ${after?.USERNAME_PROOFS} · non-fname proofs exported ${proofs.filter((x) => x.type !== 'fname').length} (info; fname proofs live off-chain)`);
    add('AC-13', pass ? 'PASS' : 'FAIL', detail);
  }

  // ---------- AC-14 ----------
  {
    const prof = exists('normalized/profile.json') ? readJson<{ records: { protocol: Record<string, string>; client: Record<string, string | number> | null }[] }>('normalized/profile.json').records[0] : undefined;
    if (!prof?.client) add('AC-14', 'FAIL', ['client profile missing']);
    else {
      const diffs = PROFILE_FIELDS.filter((k) => (prof.protocol[k] ?? '') !== String(prof.client![k] ?? ''));
      add('AC-14', diffs.length ? 'FAIL' : 'PASS', [
        `fields compared: ${PROFILE_FIELDS.join(', ')}; exact matches ${PROFILE_FIELDS.length - diffs.length}/${PROFILE_FIELDS.length}`,
        `fields set on the protocol: ${PROFILE_FIELDS.filter((k) => (prof.protocol[k] ?? '') !== '').join(', ') || 'none'}`,
        ...diffs.map((k) => `mismatch: ${k}`),
      ]);
    }
  }

  // ---------- AC-15 (schemas + CSV; the offline import-check is scripts/import-check.mjs) ----------
  {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const detail: string[] = [];
    let fail = false;
    const files = exists('normalized') ? fs.readdirSync(p('normalized')).filter((f) => f.endsWith('.json')).sort() : [];
    let validated = 0;
    let errors = 0;
    const targets = [...files.map((f) => [`normalized/${f}`, `normalized/schemas/${f.replace(/\.json$/, '.schema.json')}`]), ['reconciliation.json', 'normalized/schemas/reconciliation.schema.json']];
    for (const [rel, schemaRel] of targets) {
      if (!exists(schemaRel)) {
        fail = true;
        detail.push(`no schema for ${rel}`);
        continue;
      }
      const validate = ajv.compile(readJson(schemaRel));
      const ok = validate(readJson(rel));
      validated++;
      if (!ok) {
        fail = true;
        errors += validate.errors?.length ?? 1;
        detail.push(`${rel}: ${ajv.errorsText(validate.errors).slice(0, 300)}`);
      }
    }
    detail.unshift(`JSON Schema (ajv, draft 2020-12): ${validated} files validated, ${errors} errors`);
    const csvPairs: [string, string][] = [
      ['csv/following.csv', 'normalized/following.json'],
      ['csv/followers.csv', 'normalized/followers.json'],
      ['csv/blocks.csv', 'normalized/blocks.json'],
      ['csv/channels.csv', 'normalized/channels.json'],
      ...(isPrivate ? [['csv/bookmarks.csv', 'normalized/bookmarks.json'] as [string, string]] : []),
    ];
    for (const [csv, json] of csvPairs) {
      if (!exists(csv) || !exists(json)) {
        fail = true;
        detail.push(`missing ${csv} or ${json}`);
        continue;
      }
      const rows = parseCsv(fs.readFileSync(p(csv), 'utf8'));
      const width = rows[0]?.length ?? 0;
      const ragged = rows.filter((r) => r.length !== width).length;
      const n = readJson<{ records: unknown[] }>(json).records.length;
      const ok = ragged === 0 && rows.length - 1 === n;
      fail ||= !ok;
      detail.push(`${csv}: ${rows.length - 1} rows, ${width} columns, ragged ${ragged}; ${json} records ${n}: ${ok ? 'equal' : 'NOT equal'}`);
    }
    detail.push('offline import-check: run `node scripts/import-check.mjs DIR` separately (not part of this check)');
    add('AC-15', fail ? 'FAIL' : 'PASS', detail);
  }

  // ---------- AC-16 (export side; the repo search and git status are checked outside) ----------
  {
    const detail: string[] = [];
    const sys = osDeps(opts.os);
    let permsOk: boolean;
    if (sys.platform === 'win32') {
      // The same rules as the export's own read-back (checkOwnerOnly), over every item. No security IDs printed.
      const read = readWindowsAcls(root, sys, true);
      if (!read.ok) {
        permsOk = false;
        detail.push(`Windows permissions (security IDs) could not be read: ${read.problem}`);
      } else {
        const c = checkOwnerOnly(read.entries);
        permsOk = c.ok;
        detail.push(`Windows permissions (security IDs): inheritance removed: ${c.inheritanceRemoved ? 'yes' : 'no'}; items giving access to other accounts: ${c.itemsGivingOthers} of ${c.total}`);
        if (!c.ok) detail.push(`Windows permissions not owner-only: ${c.problems.join('; ')}`);
      }
    } else {
      const rootMode = fs.statSync(root).mode & 0o777;
      let badDirs = 0;
      let badFiles = 0;
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const q = path.join(d, e.name);
          const mode = fs.lstatSync(q).mode & 0o777;
          if (e.isDirectory()) {
            if (mode !== 0o700) badDirs++;
            walk(q);
          } else if (mode !== 0o600 && !/^\.DS_Store$|^\._/.test(e.name)) badFiles++;
        }
      };
      walk(root);
      detail.push(`export directory mode ${rootMode.toString(8)}; sub-directories not 0700: ${badDirs}; files not 0600: ${badFiles}`);
      permsOk = rootMode === 0o700 && badDirs === 0 && badFiles === 0;
    }
    const token = tokenFromEnv(opts.env);
    let hits = 0;
    if (token) {
      const s = scanTreeForSecret(root, token);
      hits = s.hits.length;
      detail.push(`FC_SESSION_TOKEN scan (raw, URL-encoded, base64, hex): ${s.filesScanned} files, ${hits} with the token`);
    } else detail.push('FC_SESSION_TOKEN not set: token scan not run by verify');
    detail.push(`manifest tokenScan: ${JSON.stringify(m.tokenScan)}`);
    // A --private run always had the token in memory, so its own scan must have run and found nothing.
    const runScanOk = isPrivate ? m.tokenScan?.ran === true && m.tokenScan.filesWithToken === 0 : (m.tokenScan?.filesWithToken ?? 0) === 0;
    if (isPrivate) detail.push(`private run: the export's own scan with the token it used ${m.tokenScan?.ran ? `ran, ${m.tokenScan.filesWithToken} file(s) with the token` : 'did NOT run'}: ${runScanOk ? 'ok' : 'FAIL'}`);
    add('AC-16', permsOk && hits === 0 && runScanOk ? 'PASS' : 'FAIL', detail);
  }

  // ---------- AC-17 (P1) ----------
  {
    const s = m.sources['client:channels'];
    const n = exists('normalized/channels.json') ? readJson<{ records: unknown[] }>('normalized/channels.json').records.length : -1;
    const pass = Boolean(s?.lastCursorEmpty) && s?.items === n;
    add('AC-17', pass ? 'PASS' : 'FAIL', [`client:channels status ${s?.status}, pages ${s?.pages}, last cursor empty ${s?.lastCursorEmpty}; items fetched ${s?.items}; normalized channels ${n}`]);
  }

  // ---------- AC-19 (P1): own casts, and bookmarked casts on --private runs ----------
  if (!exists('media/index.jsonl')) add('AC-19', 'N/A', [`--media ${m.options?.media ?? 'none'}: no media index`]);
  else {
    type Row = { status: number | null; error?: string; kind: string; stored: boolean; sha256?: string; path?: string; origins?: string[] };
    const rows = fs.readFileSync(p('media/index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row);
    const withStatus = rows.filter((r) => r.status !== null || r.error).length;
    const images = rows.filter((r) => r.kind === 'image');
    const stored = images.filter((r) => r.stored).length;
    const pathsOk = rows.filter((r) => r.stored).every((r) => r.path && r.sha256 && exists(r.path) && sha256File(p(r.path)) === r.sha256);
    const pct = images.length ? (100 * stored) / images.length : 100;
    const verdict: Verdict = withStatus !== rows.length || !pathsOk ? 'FAIL' : images.length === 0 ? 'N/A' : pct >= 95 ? 'PASS' : 'FAIL';
    const scopes = [m.sources['media:own'] ? 'own casts' : '', m.sources['media:bookmarks'] ? 'bookmarked casts' : ''].filter(Boolean);
    const byOrigin = (['own', 'bookmark'] as const)
      .filter((o) => m.sources[o === 'own' ? 'media:own' : 'media:bookmarks'])
      .map((o) => {
        const rs = rows.filter((r) => (r.origins ?? ['own']).includes(o));
        const im = rs.filter((r) => r.kind === 'image');
        return `${o === 'own' ? 'own casts' : 'bookmarked casts'}: URLs ${rs.length}, with final status ${rs.filter((r) => r.status !== null || r.error).length}; image URLs ${im.length}, stored ${im.filter((r) => r.stored).length}`;
      });
    add('AC-19', verdict, [
      `embed URLs ${rows.length}; with recorded final status ${withStatus}; statuses ${JSON.stringify(tally(rows, (r) => r.status ?? 'error'))}`,
      `image URLs ${images.length}; stored by hash ${stored} (${pct.toFixed(1)}%); stored files match their sha256 name: ${pathsOk}`,
      ...byOrigin,
      `scope: ${scopes.join(' and ') || 'none'}${!isPrivate ? '; bookmarked casts need --private' : !m.sources['media:bookmarks'] ? '; bookmarked casts not requested (--media)' : ''}`,
      ...(images.length === 0 ? ['no image URLs in this export, so the 95% clause cannot be evaluated'] : []),
    ]);
  }

  // ---------- AC-12 (P0): bookmarks ----------
  if (!isPrivate) add('AC-12', 'N/A', ['bookmarks are private data: not a --private run']);
  else {
    const s = m.sources['client:bookmarks'];
    const raw = rawPages(p('raw/client/bookmarks'));
    const rawItems = raw.bodies.flatMap((b) => (Array.isArray(b.result?.bookmarks) ? (b.result!.bookmarks as unknown[]) : []));
    const recs = records<{ hash?: string; fid?: number; text?: unknown; timestamp?: string; embeds?: unknown; inProtocol?: boolean }>('bookmarks') ?? [];
    const a = finished(s?.status) && s?.lastCursorEmpty === true && raw.errors.length === 0 && lastCursorEmpty(raw.bodies);
    const missing = { hash: 0, authorFid: 0, text: 0, timestamp: 0, embeds: 0 };
    for (const r of recs) {
      if (typeof r.hash !== 'string' || !HEX_HASH.test(r.hash)) missing.hash++;
      if (!Number.isInteger(r.fid) || (r.fid as number) <= 0) missing.authorFid++;
      if (typeof r.text !== 'string') missing.text++;
      if (typeof r.timestamp !== 'string' || !ISO.test(r.timestamp)) missing.timestamp++;
      if (!Array.isArray(r.embeds)) missing.embeds++;
    }
    const complete = recs.filter((r) => typeof r.hash === 'string' && HEX_HASH.test(r.hash) && Number.isInteger(r.fid) && (r.fid as number) > 0 && typeof r.text === 'string' && typeof r.timestamp === 'string' && ISO.test(r.timestamp) && Array.isArray(r.embeds)).length;
    const b = recs.length === rawItems.length && complete === recs.length;
    const inProtocol = recs.filter((r) => r.inProtocol).length;
    add('AC-12', a && b ? 'PASS' : 'FAIL', [
      `(a) client:bookmarks status ${s?.status}, pages ${s?.pages} (raw page files ${raw.files.length}, error files ${raw.errors.length}), last cursor empty ${s?.lastCursorEmpty} (raw last page: ${lastCursorEmpty(raw.bodies)}): ${a ? 'ok' : 'FAIL'}`,
      `(b) bookmarks in raw pages ${rawItems.length}; normalized ${recs.length}; with hash, author fid, text, timestamp and embeds ${complete}/${recs.length}: ${b ? 'ok' : 'FAIL'}`,
      ...(complete !== recs.length ? [`    missing: ${JSON.stringify(missing)}`] : []),
      `info: signed protocol cast found for ${inProtocol}/${recs.length} (${m.sources['protocol:bookmarked-casts']?.notes?.[0] ?? 'no protocol lookup'})`,
      '(c) manual: not evaluated by verify (see "Manual checks" below)',
    ], [
      'AC-12(c) bookmarks, 5 of 5: in the app, open your bookmarks and copy a distinctive phrase from the newest, the oldest and 3 random bookmarks.',
      `  For each phrase run: node bin/castsnap.js find "${root}" "PHRASE"   PASS when all 5 print a "bookmarks" line.`,
    ]);
  }

  // ---------- AC-18 (P1): direct casts ----------
  if (!isPrivate) add('AC-18', 'N/A', ['direct casts are private data: not a --private run']);
  else {
    const detail: string[] = [];
    let ok = true;
    const listIds = new Set<string>();
    const perCat: string[] = [];
    for (const c of DM_CATEGORIES) {
      const s = m.sources[`client:dm-conversations-${c}`];
      const raw = rawPages(p(`raw/client/dm-conversations-${c}`));
      const ids = raw.bodies.flatMap((b) => (Array.isArray(b.result?.conversations) ? (b.result!.conversations as { conversationId?: unknown }[]) : [])).map((x) => x?.conversationId).filter((x): x is string => typeof x === 'string');
      for (const id of ids) listIds.add(id);
      const exhausted = finished(s?.status) && s?.lastCursorEmpty === true && raw.errors.length === 0 && lastCursorEmpty(raw.bodies);
      ok &&= exhausted;
      perCat.push(`${c} ${ids.length}${exhausted ? '' : ` (NOT exhausted: ${s?.status})`}`);
    }
    detail.push(`conversation lists: ${perCat.join(', ')}; unique conversations ${listIds.size}`);
    const dcs = m.directCasts ?? [];
    const dcIds = new Set(dcs.map((d) => d.conversationId));
    const sameSet = dcIds.size === listIds.size && [...listIds].every((x) => dcIds.has(x));
    ok &&= sameSet;
    detail.push(`conversations in the manifest ${dcs.length}; same set as the raw lists: ${sameSet ? 'yes' : 'NO'}`);
    const msgs = records<{ conversationId: string }>('dm-messages') ?? [];
    const msgCount = new Map<string, number>();
    for (const r of msgs) msgCount.set(r.conversationId, (msgCount.get(r.conversationId) ?? 0) + 1);
    const notExhausted: number[] = [];
    let rawMessages = 0;
    let countMismatch = 0;
    for (const d of dcs) {
      const raw = rawPages(p(d.dir));
      const n = raw.bodies.reduce((k, b) => k + (Array.isArray(b.result?.messages) ? (b.result!.messages as unknown[]).length : 0), 0);
      rawMessages += n;
      if (n !== (msgCount.get(d.conversationId) ?? 0) || n !== d.messages) countMismatch++;
      if (!finished(d.status) || !d.lastCursorEmpty || raw.errors.length || !lastCursorEmpty(raw.bodies) || raw.files.length !== d.pages) notExhausted.push(d.index);
    }
    ok &&= notExhausted.length === 0 && countMismatch === 0 && m.sources['client:dm-messages']?.lastCursorEmpty === true;
    detail.push(`message pagination exhausted (raw last page has no cursor): ${dcs.length - notExhausted.length}/${dcs.length} conversations`);
    // Conversations are named by index only, never by id: verify output may be shared.
    if (notExhausted.length) detail.push(`not exhausted: conversation #${notExhausted.slice(0, 20).join(', #')}${notExhausted.length > 20 ? ' ...' : ''} (see manifest.directCasts)`);
    detail.push(`messages in raw pages ${rawMessages}; normalized ${msgs.length}; conversations whose counts differ ${countMismatch}`);
    add('AC-18', ok ? 'PASS' : 'FAIL', [...detail, 'spot check: manual, not evaluated by verify (see "Manual checks" below)'], [
      'AC-18 direct casts, 3 of 3: pick 3 conversations in the app, scroll each to its oldest message, and copy a phrase from it.',
      `  For each phrase run: node bin/castsnap.js find "${root}" "PHRASE"   PASS when all 3 print a "dm-messages" line.`,
    ]);
  }

  // ---------- AC-21 (P2): drafts, muted keywords, mini apps ----------
  if (!isPrivate) add('AC-21', 'N/A', ['drafts, muted keywords and mini apps are private data: not a --private run']);
  else {
    const parts: [string, string][] = [
      ['drafts', 'client:drafts'],
      ['muted keywords', 'client:muted-keywords'],
      ['mini apps', 'client:favorite-mini-apps'],
    ];
    const lines = parts.map(([label, src]) => {
      const s = m.sources[src];
      const status = s?.status ?? 'missing';
      // An empty list is a complete capture with zero items.
      const ok = (finished(status) && (!s?.paginated || s.lastCursorEmpty === true)) || /^unavailable:.+/.test(status);
      return { ok, line: `${label}: ${src} status ${status}, items ${s?.items ?? 0}${s?.paginated ? `, last cursor empty ${s.lastCursorEmpty}` : ''}: ${ok ? 'ok' : 'FAIL'}` };
    });
    const info = ['client:muted-users', 'client:muted-channels'].map((src) => `${src} ${m.sources[src]?.status} (items ${m.sources[src]?.items ?? 0})`);
    add('AC-21', lines.every((l) => l.ok) ? 'PASS' : 'FAIL', [...lines.map((l) => l.line), `info: ${info.join('; ')}`]);
  }

  // ---------- AC-20 (P1) ----------
  {
    const need = ['D8', 'D15'];
    const srcs = ['protocol:onchain-events-signer', 'protocol:onchain-signers-active', 'protocol:storage-before', 'protocol:storage-after', 'protocol:context-casts', 'client:blocked-users', 'protocol:links'];
    const bad = [...need.filter((id) => !/^(complete|empty)$/.test(m.datasets[id]?.status ?? '')), ...srcs.filter((s) => !/^(complete|empty)$/.test(m.sources[s]?.status ?? '') || (m.sources[s]?.paginated && m.sources[s]?.lastCursorEmpty !== true))];
    add('AC-20', bad.length ? 'FAIL' : 'PASS', [
      `blocks D8 ${m.datasets.D8?.status} (count ${m.datasets.D8?.count}); context casts D15 ${m.datasets.D15?.status} (count ${m.datasets.D15?.count}; ${m.sources['protocol:context-casts']?.notes?.join('; ')})`,
      `signers: on-chain signer events ${m.sources['protocol:onchain-events-signer']?.items} (${m.sources['protocol:onchain-events-signer']?.status}); storage before ${m.sources['protocol:storage-before']?.status}, after ${m.sources['protocol:storage-after']?.status}`,
      ...bad.map((b) => `not complete/exhausted: ${b}`),
    ]);
  }

  // ---------- STATUS (information: never PASS or FAIL, and never changes the exit code) ----------
  {
    const page = (name: string): unknown => {
      try {
        return readJson<unknown>(`raw/client/${name}/page-0001.json`);
      } catch {
        return undefined;
      }
    };
    const { fields, from } = pickStatus({ after: page('profile-after'), before: page('profile-before'), me: page('me') });
    const dataset = (id: string, label: string, extra: string | null = null) => {
      const d = m.datasets[id];
      return d ? `${label} ${id}: ${d.status}${d.count !== null ? `, count ${d.count}` : ''}${extra ? ` (${extra})` : ''}` : `${label} ${id}: not in this export`;
    };
    // The record's own counts (blockedByCount, mutedByCount, total), from its saved first page, on
    // --private exports only. They are personal: the docs leave sharing them to the user.
    const counts = isPrivate ? recordCounts(page('moderation-record')) : null;
    add('STATUS', 'INFO', [statusLine(fields, from), `${dataset('D19', 'own moderation record', counts)}; ${dataset('D20', 'stayed list')}`, 'information only: not graded']);
  }

  add('AC-22', 'N/A', ['setup criterion; checked from a fresh clone, not by verify']);

  checks.sort((a, b) => a.id.localeCompare(b.id));
  return { checks, exitCode: checks.some((c) => c.verdict === 'FAIL') ? 1 : 0 };
}

export function formatChecks(dir: string, checks: Check[]): string {
  const lines = [`castsnap verify ${dir}`];
  for (const c of checks) {
    lines.push(`  ${c.id} ${c.verdict.padEnd(4)} ${c.detail[0] ?? ''}`);
    for (const d of c.detail.slice(1)) lines.push(`             ${d}`);
  }
  const manual = checks.filter((c) => c.manual?.length);
  if (manual.length) {
    lines.push('Manual checks (yours to do; verify cannot see the app):');
    for (const c of manual) for (const l of c.manual!) lines.push(`  ${l}`);
  }
  const t = tally(checks, (c) => c.verdict);
  lines.push(`Result: ${t.PASS ?? 0} PASS, ${t.FAIL ?? 0} FAIL, ${t['N/A'] ?? 0} N/A${manual.length ? `; manual checks pending: ${manual.map((c) => c.id).join(', ')} (a PASS above covers only the automated parts)` : ''}`);
  return lines.join('\n');
}
