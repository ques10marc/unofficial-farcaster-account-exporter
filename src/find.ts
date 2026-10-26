// fcx find DIR <query>: case-insensitive search over an export's normalized data, for manual spot
// checks (AC-12 bookmarks, AC-18 direct casts). Matches cast and message text, hashes (prefix), fids
// (exact) and usernames. Output goes to the user's own terminal only.

import fs from 'node:fs';
import path from 'node:path';

interface Hit {
  dataset: string;
  key: string;
  when: string;
  text: string;
}

const SEARCHABLE = ['casts', 'context-casts', 'bookmarks', 'dm-messages', 'drafts', 'following', 'followers', 'blocks', 'channels', 'reactions'];

export function findInExport(dir: string, query: string): Hit[] {
  const q = query.toLowerCase();
  const asFid = /^\d+$/.test(query) ? Number(query) : null;
  const hits: Hit[] = [];
  for (const name of SEARCHABLE) {
    const file = path.join(dir, 'normalized', `${name}.json`);
    if (!fs.existsSync(file)) continue;
    const records = (JSON.parse(fs.readFileSync(file, 'utf8')).records ?? []) as Record<string, unknown>[];
    for (const r of records) {
      const hash = typeof r.hash === 'string' ? r.hash : '';
      const draftText = Array.isArray(r.casts) ? (r.casts as { text?: unknown }[]).map((c) => (typeof c?.text === 'string' ? c.text : '')).join(' / ') : '';
      const text = typeof r.text === 'string' ? r.text : draftText;
      const names = [r.username, r.displayName, r.name, r.id].filter((x): x is string => typeof x === 'string');
      const target = r.targetCastId as { hash?: string } | undefined;
      const match =
        (text && text.toLowerCase().includes(q)) ||
        (q.startsWith('0x') && q.length >= 6 && (hash.startsWith(q) || (target?.hash ?? '').startsWith(q))) ||
        (asFid !== null && r.fid === asFid) ||
        names.some((n) => n.toLowerCase().includes(q));
      if (!match) continue;
      const when = String(r.timestamp ?? r.since ?? '');
      const label = hash || (typeof r.messageId === 'string' ? `message ${r.messageId}` : '') || (typeof r.draftId === 'string' ? `draft ${r.draftId}` : '') || (r.fid !== undefined ? `fid ${r.fid}` : String(r.id ?? ''));
      hits.push({ dataset: name, key: label, when, text: (text || names.join(' ') || (target?.hash ? `reaction to ${target.hash}` : '')).replace(/\s+/g, ' ').slice(0, 140) });
    }
  }
  return hits;
}

export function formatHits(hits: Hit[]): string {
  return [...hits.map((h) => `${h.dataset.padEnd(14)} ${h.key.padEnd(42)} ${h.when.padEnd(24)} ${h.text}`), `${hits.length} match(es)`].join('\n');
}
