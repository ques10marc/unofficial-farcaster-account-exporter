// Synthetic private client data for a mock account (FID 11), shaped from the official client's
// types.yml (snapshot 2026-09-30, commit 0c289ed): ApiCast, ApiDirectCastConversationInfoV3,
// ApiDirectCastMessageV3, ApiCastDraft / ApiCaststormDraft, ApiMutedKeywordsResult, ApiMutedUser,
// ApiChannelMinimal, ApiFrame. No real user's private data is in here: bookmarks of real public casts
// reuse FID 11's recorded protocol fixture (public casts), everything else is invented.

import { createHash } from 'node:crypto';
import { Message, MessageType } from '@farcaster/core';
import { FARCASTER_EPOCH_MS, fromB64, toHex } from '../src/util.ts';
import { fixture } from './helpers.ts';

type Obj = Record<string, unknown>;

export interface PrivateFixture {
  fid: number;
  me: Obj;
  bookmarks: Obj[];
  conversations: Record<'default' | 'archived' | 'request' | 'void', Obj[]>;
  messages: Record<string, Obj[]>;
  drafts: Obj[];
  mutedKeywords: Obj;
  mutedUsers: Obj[];
  mutedChannels: Obj[];
  frames: Obj[];
  // What the fixture contains, for assertions.
  expect: { realBookmarks: number; ownCastBookmarks: number; notFoundBookmarks: number; imageUrls: number; brokenImageUrls: number; uniqueConversations: number; messages: number; oldestLongMessage: string; csvTrickyText: string };
}

const user = (fid: number): Obj => ({ fid, username: `user${fid}`, displayName: `User ${fid}`, pfp: { url: `https://img.example/pfp/${fid}.png`, verified: false }, profile: { bio: { text: '' } }, followerCount: 1, followingCount: 1 });
const fakeHash = (seed: string) => '0x' + createHash('sha256').update(seed).digest('hex').slice(0, 40);
const counts = { replies: { count: 0 }, reactions: { count: 0 }, recasts: { count: 0 }, watches: { count: 0 } };
const BASE_MS = Date.UTC(2025, 0, 1);

// An ApiCast for a real public cast from the protocol fixture.
export function apiCastFromMessage(m: Message): Obj {
  const d = m.data!;
  const b = d.castAddBody!;
  const images: Obj[] = [];
  const urls: Obj[] = [];
  const casts: Obj[] = [];
  for (const e of b.embeds) {
    if (e.url) {
      if (/imagedelivery\.net|i\.imgur\.com|\.(png|jpe?g|gif|webp)(\?|$)/i.test(e.url)) images.push({ type: 'image', url: `https://cdn.example/resized?u=${encodeURIComponent(e.url)}`, sourceUrl: e.url, alt: '' });
      else urls.push({ type: 'url', openGraph: { url: e.url, sourceUrl: e.url, title: 'page' } });
    } else if (e.castId) casts.push({ hash: toHex(e.castId.hash), threadHash: toHex(e.castId.hash), author: user(e.castId.fid), text: '', timestamp: BASE_MS });
  }
  return { hash: toHex(m.hash), threadHash: toHex(m.hash), author: user(d.fid), text: b.text, timestamp: FARCASTER_EPOCH_MS + d.timestamp * 1000, embeds: { images, urls, unknowns: [], casts }, ...counts, ...(b.parentCastId ? { parentHash: toHex(b.parentCastId.hash) } : {}) };
}

export function buildPrivateFixture(): PrivateFixture {
  const proto = fixture('fid11-protocol.json') as Record<string, unknown>;
  const client = fixture('fid11-client.json') as Record<string, { body: string }>;
  const profile = JSON.parse(client['/v2/user-by-fid?fid=11'].body).result.user;

  // Bookmarks: real public casts first (found on the protocol), then casts the node no longer has, then
  // invented ones with images, quotes, videos, tricky text.
  const found: Obj[] = [];
  const notFound: Obj[] = [];
  for (const [k, v] of Object.entries(proto)) {
    if (!k.startsWith('castById:')) continue;
    const [, fid, b64] = k.split(':');
    if (v) found.push(apiCastFromMessage(Message.decode(fromB64(v as string))));
    else notFound.push({ hash: toHex(fromB64(b64)), threadHash: toHex(fromB64(b64)), author: user(Number(fid)), text: `a cast the node no longer has (${fid})`, timestamp: BASE_MS, embeds: { images: [], urls: [], unknowns: [] }, deleted: true, ...counts });
  }
  const own = ((proto['allByFid:casts:11:'] as { messages: string[] }).messages ?? []).map((b) => Message.decode(fromB64(b))).filter((m) => m.data?.type === MessageType.CAST_ADD).map(apiCastFromMessage);
  const csvTrickyText = 'quotes "like this", commas, and\na newline';
  const invented: Obj[] = [];
  let images = 0;
  let broken = 0;
  for (let i = 1; i <= 230 - found.length - notFound.length - own.length; i++) {
    const embeds: Obj = { images: [], urls: [], unknowns: [] };
    if (i % 5 === 0) {
      const host = i === 50 ? 'gone.example' : 'img.example';
      if (host === 'gone.example') broken++;
      (embeds.images as Obj[]).push({ type: 'image', url: `https://cdn.example/b${i}.png`, sourceUrl: `https://${host}/b${i}.png`, alt: '' });
      images++;
    }
    if (i % 7 === 0) (embeds.urls as Obj[]).push({ type: 'url', openGraph: { url: `https://page.example/article/${i}`, title: 'An article' } });
    if (i % 11 === 0) embeds.videos = [{ type: 'video', url: `https://stream.example/v${i}/video.m3u8`, sourceUrl: `https://stream.example/v${i}/video.m3u8`, duration: 1000 }];
    if (i % 13 === 0) embeds.casts = [{ hash: fakeHash(`quoted-${i}`), threadHash: fakeHash(`quoted-${i}`), author: user(5000 + i), text: 'quoted', timestamp: BASE_MS }];
    const text = i === 1 ? csvTrickyText : i === 2 ? '' : i === 3 ? 'unicode: Grüße, 東京, 🚀' : `invented bookmark number ${i}`;
    invented.push({ hash: fakeHash(`bookmark-${i}`), threadHash: fakeHash(`bookmark-${i}`), author: user(1000 + i), text, timestamp: BASE_MS + i * 3_600_000, embeds, channel: i % 3 === 0 ? { key: 'mock', name: 'Mock' } : undefined, ...counts });
  }
  const bookmarks = [...found, ...own, ...notFound, ...invented].map((b) => JSON.parse(JSON.stringify(b)) as Obj);

  // Direct casts: 1:1 and group conversations across the four categories. One conversation appears in
  // two lists; one has 120 messages (3 pages); one has none; one id has characters unsafe in file names.
  const conv = (id: string, category: string, other: number, isGroup = false): Obj => ({
    conversationId: id,
    ...(isGroup ? { name: 'A group' } : {}),
    adminFids: isGroup ? [11] : [],
    removedFids: [],
    participants: [user(11), user(other)],
    lastReadTime: BASE_MS,
    selfLastReadTime: BASE_MS,
    pinnedMessages: [],
    hasPinnedMessages: false,
    isGroup,
    isCollectionTokenGated: false,
    activeParticipantsCount: 2,
    messageTTLDays: 'Infinity',
    createdAt: BASE_MS,
    unreadCount: 0,
    muted: false,
    hasMention: false,
    viewerContext: { access: 'read-write', category, archived: category === 'archived', lastReadAt: BASE_MS, muted: false, manuallyMarkedUnread: false, pinned: false, unreadCount: 0, unreadMentionsCount: 0 },
  });
  const conversations: PrivateFixture['conversations'] = { default: [], archived: [], request: [], void: [] };
  for (let i = 0; i < 60; i++) conversations.default.push(conv(`11-${2000 + i}`, 'default', 2000 + i));
  conversations.default.push(conv('g/abc+def==?x', 'default', 3000, true));
  conversations.archived.push(conv('11-2001', 'archived', 2001), conv('11-4000', 'archived', 4000));
  conversations.request.push(conv('11-5000', 'request', 5000), conv('11-5001', 'request', 5001), conv('11-5002', 'request', 5002));
  const messages: Record<string, Obj[]> = {};
  const oldestLongMessage = 'the very first message of the long conversation';
  const ids = new Set([...Object.values(conversations).flat().map((c) => c.conversationId as string)]);
  let total = 0;
  for (const id of ids) {
    const n = id === '11-2000' ? 120 : id === '11-2003' ? 0 : 1 + (id.length % 3);
    // Newest first, as the app lists them.
    messages[id] = Array.from({ length: n }, (_, k) => n - 1 - k).map((k) => ({
      conversationId: id,
      senderFid: k % 2 ? 11 : 2000,
      messageId: `m-${safe(id)}-${k}`,
      serverTimestamp: BASE_MS + k * 60_000,
      type: 'text',
      message: id === '11-2000' && k === 0 ? oldestLongMessage : `message ${k} in ${id}`,
      hasMention: false,
      reactions: [],
      isPinned: false,
      isDeleted: false,
      senderContext: { fid: k % 2 ? 11 : 2000, username: 'x', displayName: 'X', pfp: { url: 'https://img.example/p.png', verified: false } },
      ...(k > 0 && k % 10 === 0 ? { inReplyTo: { messageId: `m-${safe(id)}-${k - 1}` } } : {}),
    }));
    total += n;
  }

  const drafts: Obj[] = Array.from({ length: 54 }, (_, i) => ({ draftId: `01J${String(i).padStart(23, '0')}`, cast: { text: `draft ${i}`, embeds: i % 4 === 0 ? [`https://img.example/d${i}.png`] : [], ...(i % 9 === 0 ? { channelKey: 'mock' } : {}) }, ...(i === 3 ? { scheduledAt: BASE_MS + 86_400_000 } : {}) }));
  drafts.push({ draftId: '01JCASTSTORM00000000000000', casts: [{ text: 'storm 1' }, { text: 'storm 2', embeds: ['https://page.example/x'] }], channelKey: 'mock' });

  return {
    fid: 11,
    me: { result: { user: profile, enabledFeatureFlags: [] } },
    bookmarks,
    conversations,
    messages,
    drafts,
    mutedKeywords: { keywords: ['spoiler'], mutedKeywords: [{ keyword: 'spoiler', properties: { frames: false, channels: true } }, { keyword: 'airdrop', properties: { frames: true, channels: true } }] },
    mutedUsers: [6001, 6002, 6003].map((f) => ({ muterFid: 11, mutedFid: f, mutedUser: { fid: f, username: `muted${f}`, displayName: `Muted ${f}` }, createdAt: BASE_MS })),
    mutedChannels: [{ key: 'noisy', name: 'Noisy' }, { key: 'loud', name: 'Loud' }],
    frames: Array.from({ length: 7 }, (_, i) => ({ domain: `app${i}.example`, name: `App ${i}`, iconUrl: `https://app${i}.example/icon.png`, homeUrl: `https://app${i}.example/`, supportsNotifications: false })),
    expect: { realBookmarks: found.length, ownCastBookmarks: own.length, notFoundBookmarks: notFound.length, imageUrls: images + found.reduce((n, b) => n + ((b.embeds as Obj).images as Obj[]).length, 0) + own.reduce((n, b) => n + ((b.embeds as Obj).images as Obj[]).length, 0), brokenImageUrls: broken, uniqueConversations: ids.size, messages: total, oldestLongMessage, csvTrickyText },
  };
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9]/g, '');
