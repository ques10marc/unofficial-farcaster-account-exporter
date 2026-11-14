// The account's status in the Farcaster app, read from answers castsnap already saves: /v2/user-by-fid
// (profile-before and profile-after, in every run) and /v2/me (auth-check and --private runs). Values
// are copied as the app sent them, never interpreted; docs/USAGE.md "Account status" says what is known
// about them. scripts/quick-capture.mjs prints the same line in plain JavaScript, and
// test/account-status.test.ts keeps the two in step.
//
// Also the counting for the own moderation record and the stayed list (D19, D20), whose answer shapes
// are not documented.

import { redactThenCut } from './secrets.ts';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);

export interface StatusFields {
  optInStatus?: unknown;
  publicSpamLabel?: unknown;
  nerfed?: unknown;
  canSendDirectCasts?: unknown;
  neynarScore?: unknown;
  enabledFeatureFlags?: unknown;
}

// Copies o[key] only when the answer has it, so a field the app leaves out stays distinct from false.
function copy(out: StatusFields, field: keyof StatusFields, o: Obj | undefined, key: string = field): void {
  if (o && key in o) out[field] = o[key];
}

// /v2/user-by-fid: result.user.viewerContext and result.extras.
export function statusFromProfile(body: unknown): StatusFields | null {
  const result = obj(obj(body)?.result);
  const user = obj(result?.user);
  if (!user) return null;
  const out: StatusFields = {};
  const vc = obj(user.viewerContext);
  for (const f of ['optInStatus', 'nerfed', 'canSendDirectCasts'] as const) copy(out, f, vc);
  copy(out, 'publicSpamLabel', obj(result?.extras));
  return out;
}

// /v2/me: result.optInStatus, which wins over result.user.viewerContext.optInStatus, plus the signed-in
// fields neynarScore and enabledFeatureFlags.
export function statusFromMe(body: unknown): StatusFields | null {
  const result = obj(obj(body)?.result);
  const user = obj(result?.user);
  if (!result || !user) return null;
  const out: StatusFields = {};
  const viewer = obj(user.viewerContext);
  for (const f of ['optInStatus', 'nerfed', 'canSendDirectCasts'] as const) copy(out, f, viewer);
  copy(out, 'optInStatus', result);
  copy(out, 'neynarScore', user);
  copy(out, 'enabledFeatureFlags', result);
  return out;
}

// A value as the line shows it: a plain word as it is, anything else as JSON, redacted, then cut to at
// most 120 characters.
const show = (v: unknown): string => (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(v) ? v : redactThenCut(JSON.stringify(v) ?? String(v), 120));

// The line an export prints after its Datasets line, and auth-check after its OK line. nerfed appears
// only when the answer has it. publicSpamLabel comes only from a profile answer: /v2/me has none.
export function statusLine(s: StatusFields | null, from: string): string {
  if (!s) return `Account status: not available (no readable answer from ${from})`;
  const parts = [`optInStatus=${'optInStatus' in s ? show(s.optInStatus) : '(not reported)'}`];
  if (from.startsWith('profile-')) parts.push(`publicSpamLabel=${'publicSpamLabel' in s ? show(s.publicSpamLabel) : '(not reported)'}`);
  if ('nerfed' in s) parts.push(`nerfed=${show(s.nerfed)}`);
  return `Account status: ${parts.join(' ')} (from ${from})`;
}

// Which answer the line uses: the profile fetched last, else the first, else /v2/me.
export function pickStatus(b: { after?: unknown; before?: unknown; me?: unknown }): { fields: StatusFields | null; from: string } {
  const after = statusFromProfile(b.after);
  if (after) return { fields: after, from: 'profile-after' };
  const before = statusFromProfile(b.before);
  if (before) return { fields: before, from: 'profile-before' };
  const me = statusFromMe(b.me);
  return me ? { fields: me, from: 'me' } : { fields: null, from: 'profile-after' };
}

// Entries in answers whose shape is not documented: per page, the length of result if it is a list,
// else the summed lengths of the lists directly under result ({} counts 0). null when a page's result
// has fields but no list, so its entries can't be counted without guessing; the pages are kept anyway.
export function countEntries(bodies: unknown[]): number | null {
  let n = 0;
  for (const b of bodies) {
    const r = obj(b)?.result;
    if (Array.isArray(r)) {
      n += r.length;
      continue;
    }
    const o = obj(r);
    if (!o) return null;
    const lists = Object.values(o).filter((v): v is unknown[] => Array.isArray(v));
    if (!lists.length && Object.keys(o).length) return null;
    n += lists.reduce((sum, l) => sum + l.length, 0);
  }
  return n;
}

// The stayed list: the app reads result.count and result.users (it shows the first 4). The count is
// result.count when it is a number, else the users listed.
export function stayedCount(bodies: unknown[]): number | null {
  const r = obj(obj(bodies[0])?.result);
  if (!r) return null;
  if (typeof r.count === 'number' && Number.isFinite(r.count)) return r.count;
  return Array.isArray(r.users) ? r.users.length : null;
}

// A value's type, with no value: a list's length in brackets, (null), or (string), (number) and so on.
const kind = (v: unknown) => (Array.isArray(v) ? `[${v.length}]` : v === null ? '(null)' : `(${typeof v})`);

// The first page's result as names and types, with no values, so the note can be shared: for example
// "result: count(number), users[4]; pages 1".
export function shapeNote(bodies: unknown[]): string {
  const r = obj(bodies[0])?.result;
  const o = obj(r);
  const keys = o ? Object.keys(o) : [];
  const fields = keys.slice(0, 12).map((k) => `${redactThenCut(k, 40).replace(/[^A-Za-z0-9_]/g, '?')}${kind(o?.[k])}`);
  const shape = !o ? `result${kind(r)}` : keys.length ? `result: ${fields.join(', ')}${keys.length > 12 ? `, ${keys.length - 12} more` : ''}` : 'result: no fields';
  return `${shape}; pages ${bodies.length}`;
}

// The own moderation record's counts, for verify's STATUS line: blockedByCount, mutedByCount and total
// from the first page's result, each only when the result has it. A number is copied as the app sent
// it; any other value shows only its type, as in shapeNote, so the line never holds text from the
// answer. null when there is no readable result or it has none of the three.
export function recordCounts(body: unknown): string | null {
  const r = obj(obj(body)?.result);
  if (!r) return null;
  const parts = (['blockedByCount', 'mutedByCount', 'total'] as const).filter((k) => k in r).map((k) => `${k} ${typeof r[k] === 'number' ? String(r[k]) : kind(r[k])}`);
  return parts.length ? parts.join(', ') : null;
}
