import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClientApi } from '../src/client.ts';
import { type ExportOptions, runExport } from '../src/export.ts';
import type { ProtocolTransport } from '../src/protocol/types.ts';
import { RateLimiter } from '../src/util.ts';
import { type ClientStore, ReplayTransport, replayFetch, type SeenRequest } from './replay.ts';

export const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
export const tmpDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Export of FID 11 replayed from recorded fixtures: no network.
export async function replayExport(over: Partial<ExportOptions> & { clientStore?: ClientStore; transport?: ProtocolTransport } = {}) {
  const seen: SeenRequest[] = [];
  const logs: string[] = [];
  const transport = over.transport ?? new ReplayTransport(fixture('fid11-protocol.json'));
  const client = new ClientApi({ fetchImpl: replayFetch(over.clientStore ?? fixture('fid11-client.json'), seen), limiter: new RateLimiter({ windows: [] }), wait: async () => {}, log: (s) => logs.push(s) });
  const refuse = (async () => {
    throw new Error('media fetch not expected in replay');
  }) as typeof fetch;
  const r = await runExport({
    fid: 11,
    out: tmpDir('fcx-replay-'),
    media: 'own',
    transports: [transport],
    client,
    mediaFetch: refuse,
    retryWait: async () => {},
    log: (s) => logs.push(s),
    env: {},
    ...over,
  });
  return { ...r, seen, logs };
}
