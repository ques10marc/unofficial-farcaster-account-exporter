import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { downloadMedia, isPrivateAddress } from '../src/media.ts';
import { ExportWriter } from '../src/writer.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

test('private and loopback addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['1.1.1.1', '104.18.0.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  // IPv4 inside IPv6, in the spellings a URL or a resolver can produce, and the rest of ::/96.
  for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:c0a8:101', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '64:ff9b::a00:5', '::7f00:1', '::127.0.0.1', '::', 'fe80::1%lo0', 'ff02::1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['::ffff:808:808', '::ffff:8.8.8.8', '64:ff9b::808:808', '2001:4860:4860::8888']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('media: images stored by sha256, pages and 404s get a status only, private targets refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcx-media-'));
  const w = ExportWriter.create(dir, 1);
  const requested: string[] = [];
  const fetchImpl = (async (u: URL) => {
    requested.push(u.toString());
    if (u.host === 'img.example') return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    if (u.host === 'page.example') return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (u.host === 'gone.example') return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
    if (u.host === 'redir.example') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
    throw new Error(`unexpected request ${u}`);
  }) as typeof fetch;
  const resolve = async (host: string) => (host === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34']);
  const refs = [
    { url: 'https://img.example/a.png', castHash: '0x01' },
    { url: 'https://img.example/a.png', castHash: '0x02' },
    { url: 'https://page.example/', castHash: '0x03' },
    { url: 'https://gone.example/x.jpg', castHash: '0x04' },
    { url: 'https://redir.example/r', castHash: '0x05' },
    { url: 'http://localhost:8080/x.png', castHash: '0x06' },
    { url: 'https://internal.example/x.png', castHash: '0x07' },
    { url: 'file:///etc/passwd', castHash: '0x08' },
  ];
  const { rows, stats } = await downloadMedia(refs, w, { fetchImpl, resolve, wait: async () => {} });
  assert.equal(stats.urls, 7);
  assert.equal(stats.withFinalStatus, 7);
  const img = rows.find((r) => r.url === 'https://img.example/a.png')!;
  const sha = createHash('sha256').update(PNG).digest('hex');
  assert.equal(img.sha256, sha);
  assert.deepEqual(img.castHashes, ['0x01', '0x02']);
  assert.deepEqual(fs.readFileSync(path.join(w.root, `media/sha256/${sha.slice(0, 2)}/${sha}`)), PNG);
  assert.equal(rows.find((r) => r.url === 'https://page.example/')!.note, 'not-media');
  assert.equal(rows.find((r) => r.url === 'https://gone.example/x.jpg')!.status, 404);
  // A missing image is still an image (its 404 page's content type must not reclassify it), so AC-19
  // counts it as an image that was not stored.
  assert.equal(rows.find((r) => r.url === 'https://gone.example/x.jpg')!.kind, 'image');
  // Images: a.png (stored), x.jpg (404), and the two refused private-address .png URLs.
  assert.equal(stats.imageUrls, 4);
  assert.equal(stats.imagesStored, 1);
  assert.match(rows.find((r) => r.url === 'https://redir.example/r')!.error!, /refused private address/);
  assert.match(rows.find((r) => r.url.startsWith('http://localhost'))!.error!, /refused host localhost/);
  assert.match(rows.find((r) => r.url.startsWith('https://internal'))!.error!, /refused private address/);
  assert.match(rows.find((r) => r.url.startsWith('file:'))!.error!, /refused scheme/);
  assert.ok(!requested.some((u) => /127\.0\.0\.1|localhost|internal/.test(u)), 'never requested a private target');
});

test('media: an IPv4 address written as IPv6 in a URL is refused without a request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcx-media-'));
  const w = ExportWriter.create(dir, 1);
  const requested: string[] = [];
  const fetchImpl = (async (u: URL) => {
    requested.push(u.toString());
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  const refs = ['http://[::ffff:127.0.0.1]/x.png', 'http://[::ffff:169.254.169.254]/latest', 'http://[::ffff:c0a8:101]/x.png'].map((url, i) => ({ url, castHash: `0x0${i}` }));
  const { rows } = await downloadMedia(refs, w, { fetchImpl, resolve: async () => ['93.184.216.34'], wait: async () => {} });
  for (const r of rows) assert.match(r.error!, /refused private address/, r.url);
  assert.deepEqual(requested, []);
});

test('media: once stored media reach the total cap, the remaining URLs are skipped without a request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcx-media-'));
  const w = ExportWriter.create(dir, 1);
  const requested: string[] = [];
  // Distinct bodies, so each one is stored and counted: the PNG header plus the 6-byte path.
  const fetchImpl = (async (u: URL) => {
    requested.push(u.toString());
    return new Response(Buffer.concat([PNG, Buffer.from(u.pathname)]), { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  const logs: string[] = [];
  const refs = ['a', 'b', 'c', 'd'].map((n, i) => ({ url: `https://img.example/${n}.png`, castHash: `0x0${i}` }));
  const opts = { fetchImpl, resolve: async () => ['93.184.216.34'], wait: async () => {}, log: (s: string) => logs.push(s), maxTotalBytes: 2 * (PNG.length + 6) };
  const { rows, stats } = await downloadMedia(refs, w, opts);
  assert.deepEqual(requested, ['https://img.example/a.png', 'https://img.example/b.png']);
  assert.deepEqual(rows.map((r) => r.stored), [true, true, false, false]);
  for (const r of rows.slice(2)) assert.match(r.error!, /^skipped: stored media reached \d+ bytes$/);
  assert.equal(stats.withFinalStatus, 4);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /skipping the remaining 2 URLs/);
});
