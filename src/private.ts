// Private client data (--private): bookmarks (D3), direct casts (D10), drafts (D11), mutes (D12) and
// favourite mini apps (D13). Paths, result keys and page sizes come from the official client's types.yml
// (snapshot 2026-09-30, commit 0c289ed). A quick-capture run fetched every one of them with a web session
// token alone; direct casts needed no separate dc_auth token.
//
// This module decides what to fetch and in which order; export.ts writes the verbatim pages and keeps the
// manifest. Every request here carries the session token, so every request goes through ClientApi with
// auth, which only sends it to the allowed client hosts.

import type { SourceEntry } from './export.ts';

export const DM_CATEGORIES = ['default', 'archived', 'request', 'void'] as const;

export interface PagedCapture {
  entry: SourceEntry;
  items: unknown[];
}

export interface ObjectCapture {
  entry: SourceEntry;
  body?: unknown;
}

export interface CaptureHelpers {
  // register false: the source is not added to manifest.sources (one per DM conversation would be
  // hundreds); its entry is returned and summarised instead.
  paged(o: { name: string; dir?: string; path: string; params: Record<string, string | number>; itemsKey: string; limit: number; register?: boolean }): Promise<PagedCapture>;
  // count: number of items in the body; 0 makes the source 'empty' rather than 'complete'.
  object(o: { name: string; path: string; params: Record<string, string | number>; count: (body: unknown) => number }): Promise<ObjectCapture>;
  register(name: string, entry: SourceEntry): void;
  log(s: string): void;
  isInterrupted(): boolean;
}

export interface DmConversation {
  index: number;
  conversationId: string;
  categories: string[];
  info: Record<string, unknown>;
  dir: string;
  status: string;
  pages: number;
  messages: unknown[];
  lastCursorEmpty: boolean;
  limitUsed?: number;
}

// Whatever was captured, even when a source stopped early: its status in manifest.sources says whether
// it is complete, and a partial capture is still worth keeping.
export interface PrivateData {
  bookmarks: Record<string, unknown>[];
  conversations: DmConversation[];
  drafts: unknown[];
  mutedKeywords: Record<string, unknown> | null; // ApiMutedKeywordsResult; null when not fetched
  mutedUsers: unknown[];
  mutedChannels: unknown[] | null; // ApiMutedChannelsResult.mutedChannels; null when not fetched
  miniApps: unknown[];
}

// ApiMutedKeywordsResult has keywords (strings, which types.yml calls not extensible) and mutedKeywords
// (objects). Both are kept; the union by keyword is the list.
export function mutedKeywordList(result: Record<string, unknown> | undefined): { keyword: string; properties?: Record<string, unknown> }[] {
  const out = new Map<string, { keyword: string; properties?: Record<string, unknown> }>();
  for (const k of Array.isArray(result?.mutedKeywords) ? (result.mutedKeywords as Record<string, unknown>[]) : []) {
    if (typeof k?.keyword === 'string') out.set(k.keyword, { keyword: k.keyword, ...(k.properties && typeof k.properties === 'object' ? { properties: k.properties as Record<string, unknown> } : {}) });
  }
  for (const k of Array.isArray(result?.keywords) ? (result.keywords as unknown[]) : []) if (typeof k === 'string' && !out.has(k)) out.set(k, { keyword: k });
  return [...out.values()];
}

const done = (s: string) => s === 'complete' || s === 'empty';
const pad = (n: number) => String(n).padStart(4, '0');
export const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');

export async function capturePrivate(h: CaptureHelpers, onBookmarks: (bookmarks: Record<string, unknown>[]) => void): Promise<PrivateData> {
  const data: PrivateData = { bookmarks: [], conversations: [], drafts: [], mutedKeywords: null, mutedUsers: [], mutedChannels: null, miniApps: [] };
  try {
    // Bookmarks first: they exist only on the app's servers and are the highest-priority private data.
    const b = await h.paged({ name: 'bookmarks', path: '/v2/bookmarked-casts', params: {}, itemsKey: 'bookmarks', limit: 100 });
    data.bookmarks = b.items as Record<string, unknown>[];
  } finally {
    onBookmarks(data.bookmarks);
  }

  // Direct casts: every category's conversation list, then each unique conversation's messages.
  const byId = new Map<string, DmConversation>();
  const listsOk: boolean[] = [];
  for (const category of DM_CATEGORIES) {
    if (h.isInterrupted()) break;
    const r = await h.paged({ name: `dm-conversations-${category}`, path: '/v2/direct-cast-conversation-list', params: { category }, itemsKey: 'conversations', limit: 50 });
    listsOk.push(done(r.entry.status));
    for (const c of r.items as Record<string, unknown>[]) {
      const id = typeof c?.conversationId === 'string' ? c.conversationId : '';
      if (!id) continue;
      const known = byId.get(id);
      if (known) {
        if (!known.categories.includes(category)) known.categories.push(category);
        continue;
      }
      const index = byId.size + 1;
      byId.set(id, { index, conversationId: id, categories: [category], info: c, dir: `dm-messages/${pad(index)}-${safeName(id).slice(0, 80)}`, status: 'error:not-started', pages: 0, messages: [], lastCursorEmpty: false });
    }
  }
  data.conversations = [...byId.values()];
  const agg: SourceEntry = { kind: 'client', host: null, paginated: true, status: 'error:not-started', pages: 0, items: 0, lastCursorEmpty: false, files: [] };
  let n = 0;
  for (const c of data.conversations) {
    if (h.isInterrupted()) break;
    if (++n % 50 === 0) h.log(`    direct casts: ${n}/${data.conversations.length} conversations`);
    const r = await h.paged({ name: `dm-messages:${c.index}`, dir: c.dir, path: '/v2/direct-cast-conversation-messages', params: { conversationId: c.conversationId }, itemsKey: 'messages', limit: 50, register: false });
    Object.assign(c, { status: r.entry.status, pages: r.entry.pages, messages: r.items, lastCursorEmpty: r.entry.lastCursorEmpty === true });
    if (r.entry.notes?.[0]?.startsWith('limit=')) c.limitUsed = Number(r.entry.notes[0].slice(6)) || undefined;
    agg.host = r.entry.host;
    agg.pages += r.entry.pages;
    agg.items += r.items.length;
    agg.files.push(...r.entry.files);
  }
  const notDone = data.conversations.filter((c) => !done(c.status));
  agg.lastCursorEmpty = notDone.length === 0 && listsOk.length === DM_CATEGORIES.length && listsOk.every(Boolean);
  agg.status = h.isInterrupted() ? 'interrupted' : notDone.length ? `error:${notDone.length}-conversations-not-complete` : data.conversations.length ? (agg.items ? 'complete' : 'empty') : 'empty';
  agg.notes = [`conversations ${data.conversations.length}; message pagination exhausted ${data.conversations.length - notDone.length}; not complete ${notDone.length}`];
  h.register('client:dm-messages', agg);

  const drafts = await h.paged({ name: 'drafts', path: '/v2/draft-casts', params: {}, itemsKey: 'drafts', limit: 50 });
  data.drafts = drafts.items;

  const kw = await h.object({ name: 'muted-keywords', path: '/v2/get-muted-keywords', params: {}, count: (b) => mutedKeywordList((b as { result?: Record<string, unknown> })?.result).length });
  data.mutedKeywords = done(kw.entry.status) ? (((kw.body as { result?: Record<string, unknown> })?.result ?? {}) as Record<string, unknown>) : null;

  const mu = await h.paged({ name: 'muted-users', path: '/v2/get-muted-users', params: {}, itemsKey: 'mutedUsers', limit: 50 });
  data.mutedUsers = mu.items;

  const channelsOf = (b: unknown) => {
    const c = (b as { result?: { mutedChannels?: unknown } })?.result?.mutedChannels;
    return Array.isArray(c) ? c : [];
  };
  const mc = await h.object({ name: 'muted-channels', path: '/v2/get-muted-channels', params: {}, count: (b) => channelsOf(b).length });
  data.mutedChannels = done(mc.entry.status) ? channelsOf(mc.body) : null;

  const fa = await h.paged({ name: 'favorite-mini-apps', path: '/v1/favorite-frames', params: {}, itemsKey: 'frames', limit: 50 });
  data.miniApps = fa.items;
  return data;
}
