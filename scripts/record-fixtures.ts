// Records the test fixtures in test/fixtures/ from live public endpoints.
// Usage: node scripts/record-fixtures.ts <scratch-dir>   (the throwaway export goes to <scratch-dir>)
//
// - fid11-protocol.json: every gRPC call an export of FID 11 makes (base64 protobuf).
// - fid11-client.json: every public client API response for that export. User objects in follow lists
//   are trimmed to fid/username/displayName to keep other accounts' profile data out of the repo.
// - http-vs-grpc.json: the same messages/events from the HTTP API (verbatim JSON) and gRPC (protobuf),
//   for the converter tests: FID 13's verifications (Solana + contract wallet) and FID 4's
//   ID-register event (HTTP renders its enum as "Register").

import fs from 'node:fs';
import path from 'node:path';
import { Message, OnChainEvent, OnChainEventType } from '@farcaster/core';
import { ClientApi } from '../src/client.ts';
import { runExport } from '../src/export.ts';
import { GrpcTransport } from '../src/protocol/grpc.ts';
import { RateLimiter, toB64 } from '../src/util.ts';
import { type ClientStore, RecordingTransport, recordingFetch } from '../test/replay.ts';

const scratch = process.argv[2];
if (!scratch) throw new Error('usage: node scripts/record-fixtures.ts <scratch-dir>');
const outDir = path.join(import.meta.dirname, '..', 'test', 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

const trimUsers = (_key: string, body: string): string => {
  const j = JSON.parse(body);
  if (Array.isArray(j?.result?.users)) j.result.users = j.result.users.map((u: Record<string, unknown>) => ({ fid: u.fid, username: u.username, displayName: u.displayName }));
  if (j?.result?.leastInteractedWith) delete j.result.leastInteractedWith;
  return JSON.stringify(j);
};

const grpc = new RecordingTransport(new GrpcTransport('snap.farcaster.xyz:3383'));
const client: ClientStore = {};
const r = await runExport({
  fid: 11,
  out: scratch,
  media: 'own',
  transports: [grpc],
  client: new ClientApi({ fetchImpl: recordingFetch(client, trimUsers), limiter: new RateLimiter({ windows: [{ max: 20, ms: 10_000 }], minGapMs: 500 }) }),
});
console.log(`recording export exit ${r.exitCode}: ${r.dir}`);
fs.writeFileSync(path.join(outDir, 'fid11-protocol.json'), JSON.stringify(grpc.calls, null, 1) + '\n');
fs.writeFileSync(path.join(outDir, 'fid11-client.json'), JSON.stringify(client, null, 1) + '\n');

const g = new GrpcTransport('snap.farcaster.xyz:3383');
const httpVerifs = await (await fetch('https://snap.farcaster.xyz:3381/v1/verificationsByFid?fid=13&pageSize=1000')).text();
const grpcVerifs = await g.allByFid('verifications', 13);
const httpIdReg = await (await fetch('https://snap.farcaster.xyz:3381/v1/onChainEventsByFid?fid=4&event_type=EVENT_TYPE_ID_REGISTER')).text();
const grpcIdReg = await g.onChainEvents(4, OnChainEventType.EVENT_TYPE_ID_REGISTER);
g.close();
fs.writeFileSync(
  path.join(outDir, 'http-vs-grpc.json'),
  JSON.stringify(
    {
      verificationsFid13: { http: httpVerifs, grpc: grpcVerifs.messages.map((m) => toB64(Message.encode(m).finish())) },
      idRegisterFid4: { http: httpIdReg, grpc: grpcIdReg.events.map((e) => toB64(OnChainEvent.encode(e).finish())) },
    },
    null,
    1,
  ) + '\n',
);
for (const f of fs.readdirSync(outDir)) console.log(`${f} ${fs.statSync(path.join(outDir, f)).size} bytes`);
