// Which user-agent each kind of host gets (SPEC "Network etiquette"), over real connections to local
// servers. Media hosts are covered in media.test.ts.

import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { getInsecureClient } from '@farcaster/hub-nodejs';
import { ClientApi } from '../src/client.ts';
import { GrpcTransport } from '../src/protocol/grpc.ts';
import { HttpTransport } from '../src/protocol/http.ts';
import { USER_AGENT } from '../src/util.ts';

async function listen<T extends http.Server | http2.Http2Server>(server: T): Promise<{ server: T; port: number }> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, port: (server.address() as AddressInfo).port };
}

test('protocol nodes are told the requests come from fcx, over HTTP and gRPC', { timeout: 10_000 }, async () => {
  const seen: (string | undefined)[] = [];
  const h1 = await listen(http.createServer((req, res) => {
    seen.push(req.headers['user-agent']);
    res.writeHead(500).end();
  }));
  const h2 = await listen(http2.createServer());
  h2.server.on('stream', (stream, headers) => {
    seen.push(headers['user-agent']);
    stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '12' }, { endStream: true });
  });
  const grpc = new GrpcTransport(`127.0.0.1:${h2.port}`, getInsecureClient);
  try {
    await assert.rejects(new HttpTransport(`http://127.0.0.1:${h1.port}`).storageLimits(1));
    await assert.rejects(grpc.shardZeroHeight());
    assert.equal(seen[0], USER_AGENT);
    assert.ok(seen[1]?.startsWith(`${USER_AGENT} grpc-node-js/`), seen[1]);
  } finally {
    grpc.close();
    h1.server.closeAllConnections();
    h1.server.close();
    h2.server.close();
  }
});

test("the client API gets Node's default user-agent", { timeout: 10_000 }, async () => {
  let seen: string | undefined;
  const h1 = await listen(http.createServer((req, res) => {
    seen = req.headers['user-agent'];
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  }));
  try {
    await new ClientApi({ bases: [`http://127.0.0.1:${h1.port}`], explicitBase: true }).get('/v2/user-by-fid', { fid: 1 });
    assert.equal(seen, 'node');
  } finally {
    h1.server.closeAllConnections();
    h1.server.close();
  }
});
