// Small shared helpers: time, bytes, errors, rate limiting.

export const VERSION = '0.1.0';
export const LIBRARIES = { '@farcaster/core': '0.20.0', '@farcaster/hub-nodejs': '0.17.0' } as const;

// Farcaster timestamps are seconds since 2021-01-01T00:00:00Z.
export const FARCASTER_EPOCH_MS = 1_609_459_200_000;
export const fcTimeToIso = (t: number): string => new Date(FARCASTER_EPOCH_MS + t * 1000).toISOString();

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const toHex = (b: Uint8Array | undefined | null): string => (b && b.length ? '0x' + Buffer.from(b).toString('hex') : '');
export const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h.replace(/^0x/, ''), 'hex'));
export const toB64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
export const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// UTC stamp for directory names, in the form YYYYMMDDTHHMMSSZ
export const utcStamp = (d = new Date()): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

export function tally<T>(items: Iterable<T>, key: (x: T) => string | number | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of items) {
    const k = String(key(x));
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// Sliding-window limiter: waits until every window has room. One instance per host.
export class RateLimiter {
  private readonly windows: { max: number; ms: number }[];
  private readonly minGapMs: number;
  private readonly stamps: number[] = [];
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: { windows: { max: number; ms: number }[]; minGapMs?: number; now?: () => number; wait?: (ms: number) => Promise<void> }) {
    this.windows = opts.windows;
    this.minGapMs = opts.minGapMs ?? 0;
    this.now = opts.now ?? Date.now;
    this.wait = opts.wait ?? sleep;
  }

  // Returns how long the caller waited, in ms. Calls are serialized: one request at a time per host.
  take(): Promise<number> {
    const run = this.chain.then(async () => {
      let waited = 0;
      for (;;) {
        const t = this.now();
        let need = 0;
        const last = this.stamps[this.stamps.length - 1];
        if (last !== undefined) need = Math.max(need, last + this.minGapMs - t);
        for (const w of this.windows) {
          const inWindow = this.stamps.filter((s) => s > t - w.ms);
          if (inWindow.length >= w.max) need = Math.max(need, inWindow[inWindow.length - w.max] + w.ms - t + 1);
        }
        if (need <= 0) break;
        waited += need;
        await this.wait(need);
      }
      this.stamps.push(this.now());
      const longest = Math.max(0, ...this.windows.map((w) => w.ms));
      while (this.stamps.length && this.stamps[0] <= this.now() - longest) this.stamps.shift();
      return waited;
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
}

// Interrupt flag shared by long-running loops (Ctrl-C finishes the current request, then stops).
export const interrupt = { requested: false };
