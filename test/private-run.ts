// A full `castsnap export --private` against the local mock server: client requests (public and private) go
// over real HTTP to 127.0.0.1, the protocol is replayed from FID 11's recorded fixture, and media is
// served by a stub. No request leaves the machine.
//
// Standalone:
//   node test/private-run.ts <out-dir>     prints the export log and the verify report, exit = verify's

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CastType, FarcasterNetwork, makeCastAdd, Message, NobleEd25519Signer } from '@farcaster/core';
import { ClientApi, type ClientOptions } from '../src/client.ts';
import { type ExportOptions, runExport } from '../src/export.ts';
import { TransportError } from '../src/protocol/types.ts';
import { FARCASTER_EPOCH_MS, RateLimiter, toB64, toHex } from '../src/util.ts';
import { formatChecks, verifyExport } from '../src/verify.ts';
import { decodeDelimited } from '../src/writer.ts';
import { fixture, tmpDir } from './helpers.ts';
import { type MockOptions, startMock } from './mock-server.ts';
import { apiCastFromMessage, buildPrivateFixture } from './private-fixtures.ts';
import { ReplayTransport } from './replay.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

// A signed cast that only the bookmark lookup can find: its author (fid 999) is not in FID 11's recording,
// so it is neither an own cast nor a context cast. Signed with a throwaway key derived from a fixed
// string, so the cast and its hash are the same on every run; the key is registered nowhere.
export async function lookupOnlyCast(): Promise<Message> {
  const signer = new NobleEd25519Signer(new Uint8Array(createHash('sha256').update('castsnap throwaway test signer, fid 999').digest()));
  const body = { text: 'a bookmarked cast that only the bookmark lookup finds', embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], type: CastType.CAST };
  const r = await makeCastAdd(body, { fid: 999, network: FarcasterNetwork.MAINNET, timestamp: (Date.UTC(2025, 5, 1) - FARCASTER_EPOCH_MS) / 1000 }, signer);
  if (r.isErr()) throw r.error;
  return r.value;
}

// The node "no longer has" casts that are not in the recording (invented bookmarks).
export class MockProtocol extends ReplayTransport {
  async castById(fid: number, hash: Uint8Array) {
    try {
      return await super.castById(fid, hash);
    } catch (e) {
      if (e instanceof TransportError && e.code === 'fixture_miss') return null;
      throw e;
    }
  }
}

export interface MediaCall {
  url: string;
  headers: Record<string, string>;
}

// makeClient: builds the client from the harness's options (pointed at the mock), so a test can wrap its
// fetch or subclass it.
export async function mockPrivateExport(o: { token?: string; mock?: Partial<MockOptions>; out?: string; export?: Partial<ExportOptions>; onMedia?: (outDir: string) => void; makeClient?: (opts: ClientOptions) => ClientApi } = {}) {
  const token = o.token ?? `castsnap-sentinel-${randomUUID()}`;
  // The lookup-only cast is appended last, so the other bookmarks keep their positions.
  const lookupOnly = await lookupOnlyCast();
  const data = o.mock?.data ?? buildPrivateFixture();
  const mock = await startMock({ token, rejectPrefixes: { primary: 401 }, once429: ['/v1/favorite-frames'], ...o.mock, data: { ...data, bookmarks: [...data.bookmarks, apiCastFromMessage(lookupOnly)] } });
  const out = o.out ?? tmpDir('castsnap-private-');
  const logs: string[] = [];
  const mediaCalls: MediaCall[] = [];
  const noWait = async () => {};
  const clientOptions: ClientOptions = {
    token,
    bases: [`${mock.url}/primary`, `${mock.url}/~api`],
    explicitBase: false,
    limiter: new RateLimiter({ windows: [] }),
    privateLimiter: new RateLimiter({ windows: [] }),
    wait: noWait,
    log: (s) => logs.push(s),
  };
  const client = o.makeClient ? o.makeClient(clientOptions) : new ClientApi(clientOptions);
  let first = true;
  const mediaFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : input.toString());
    mediaCalls.push({ url: u.toString(), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (first) {
      first = false;
      o.onMedia?.(out);
    }
    if (u.host === 'gone.example') return new Response('gone', { status: 404, headers: { 'content-type': 'text/plain' } });
    if (['img.example', 'imagedelivery.net', 'i.imgur.com'].includes(u.host)) return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    if (u.host === 'stream.example') return new Response('#EXTM3U\n', { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
    return new Response('<html>page</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  try {
    const result = await runExport({
      fid: 11,
      out,
      media: 'own,bookmarks',
      private: true,
      token,
      transports: [new MockProtocol({ ...fixture('fid11-protocol.json'), [`castById:999:${toB64(lookupOnly.hash)}`]: toB64(Message.encode(lookupOnly).finish()) })],
      client,
      mediaFetch,
      mediaResolve: async () => ['93.184.216.34'],
      mediaWait: noWait,
      retryWait: noWait,
      log: (s) => logs.push(s),
      env: {},
      ...o.export,
    });
    return { result, token, mock, logs, mediaCalls, out, lookupOnly };
  } finally {
    await mock.close();
  }
}

if (import.meta.main) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('usage: node test/private-run.ts <out-dir>');
    process.exit(64);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const r = await mockPrivateExport({ out: outDir });
  for (const l of r.logs) console.log(l.split(r.token).join('[SENTINEL]'));
  console.log(`export exit code: ${r.result.exitCode}`);
  const auth = r.mock.requests.filter((q) => q.auth !== 'none');
  console.log(`mock requests: ${r.mock.requests.length}; with a token ${auth.length} (all private paths: ${auth.every((q) => q.path.startsWith('/v'))}); public paths with a token: ${r.mock.requests.filter((q) => q.auth !== 'none' && !['/v2/me', '/v2/bookmarked-casts', '/v2/direct-cast-conversation-list', '/v2/direct-cast-conversation-messages', '/v2/draft-casts', '/v2/get-muted-keywords', '/v2/get-muted-users', '/v2/get-muted-channels', '/v1/favorite-frames', '/v2/network-code/public-rap-sheet', '/v2/opt-in/following-stayed'].includes(q.path)).length}`);
  console.log(`media requests: ${r.mediaCalls.length}; with an authorization header: ${r.mediaCalls.filter((c) => c.headers.authorization !== undefined).length}`);
  const lookupHash = toHex(r.lookupOnly.hash);
  const pb = path.join(r.result.dir, 'raw/protocol/bookmarked-casts.pb');
  const inPb = fs.existsSync(pb) && decodeDelimited(fs.readFileSync(pb)).some((b) => toHex(Message.decode(b).hash) === lookupHash);
  const rec = JSON.parse(fs.readFileSync(path.join(r.result.dir, 'normalized/bookmarks.json'), 'utf8')).records.find((b: { hash?: string }) => b.hash === lookupHash);
  console.log(`lookup-only bookmark ${lookupHash} (fid 999): in raw/protocol/bookmarked-casts.pb ${inPb}; normalized position ${rec?.position}, inProtocol ${rec?.inProtocol}`);
  const v = await verifyExport(r.result.dir, { env: { FC_SESSION_TOKEN: r.token } });
  console.log(formatChecks(path.resolve(r.result.dir), v.checks).split(r.token).join('[SENTINEL]'));
  process.exit(v.exitCode);
}
