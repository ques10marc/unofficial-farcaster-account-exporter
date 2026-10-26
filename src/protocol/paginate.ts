// Hub pagination. Single-shard endpoints end on an empty token. Cross-shard endpoints (followers via
// linksByTarget, and GetAll* on a multi-shard node) end on a token that decodes to an array of nulls,
// e.g. '[null,null]'; following that token returns the same page again, as seen on snap.farcaster.xyz.
// A token seen before is an error, never a reason to loop.

import { sleep } from '../util.ts';
import { TransportError } from './types.ts';

export type PageEnd = 'empty-token' | 'all-null-shard-token';

export function isAllNullShardToken(token: Uint8Array): boolean {
  return /^\[\s*null\s*(,\s*null\s*)*\]$/.test(Buffer.from(token).toString('latin1'));
}

export class PaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaginationError';
  }
}

export interface Paged<T> {
  items: T[];
  pages: number;
  end: PageEnd;
  raws: string[];
}

export async function collectPages<T>(
  fetchPage: (token?: Uint8Array) => Promise<{ items: T[]; nextPageToken?: Uint8Array; raw?: string }>,
  opts: { maxPages?: number; isInterrupted?: () => boolean } = {},
): Promise<Paged<T>> {
  const maxPages = opts.maxPages ?? 100_000;
  const seen = new Set<string>();
  const items: T[] = [];
  const raws: string[] = [];
  let token: Uint8Array | undefined;
  for (let pages = 1; pages <= maxPages; pages++) {
    const page = await fetchPage(token);
    items.push(...page.items);
    if (page.raw !== undefined) raws.push(page.raw);
    const next = page.nextPageToken;
    if (!next || next.length === 0) return { items, pages, end: 'empty-token', raws };
    if (isAllNullShardToken(next)) return { items, pages, end: 'all-null-shard-token', raws };
    const key = Buffer.from(next).toString('base64');
    if (seen.has(key)) throw new PaginationError(`repeated page token after ${pages} page(s)`);
    seen.add(key);
    if (opts.isInterrupted?.()) throw new PaginationError('interrupted');
    token = next;
  }
  throw new PaginationError(`more than ${maxPages} pages`);
}

// Retries retryable transport errors on the same host with exponential backoff.
export async function withRetry<T>(fn: () => Promise<T>, opts: { attempts?: number; baseMs?: number; onRetry?: (e: unknown, attempt: number, waitMs: number) => void; wait?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseMs = opts.baseMs ?? 1000;
  const wait = opts.wait ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e instanceof TransportError && e.retryable;
      if (!retryable || attempt >= attempts) throw e;
      const ms = Math.min(60_000, baseMs * 2 ** (attempt - 1));
      opts.onRetry?.(e, attempt, ms);
      await wait(ms);
    }
  }
}
