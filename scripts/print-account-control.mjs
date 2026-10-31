#!/usr/bin/env node
// Read-only: print the custody and recovery address on record for a castsnap export, from its
// on-chain ID-registry events alone. It makes no network calls and writes nothing.
//
//   node scripts/print-account-control.mjs <your-export-dir>
//
// It reads only <your-export-dir>/raw/protocol/onchain-events-id-register.pb. On macOS you can
// have the operating system enforce "no network" too:
//   sandbox-exec -p '(version 1)(allow default)(deny network*)' node scripts/print-account-control.mjs <dir>

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { OnChainEvent, IdRegisterEventType } from '@farcaster/core';

// Make the read-only promise enforceable in-process: refuse any network.
const refuse = () => { throw new Error('this script does not use the network'); };
globalThis.fetch = refuse;
net.connect = refuse;
net.createConnection = refuse;

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/print-account-control.mjs <export-dir>');
  process.exit(64);
}

const file = path.join(dir, 'raw/protocol/onchain-events-id-register.pb');
if (!fs.existsSync(file)) {
  console.error(`No ID-registry events in this export (${file} not found).`);
  console.error('Run an export that includes on-chain events (dataset D7), then try again.');
  process.exit(1);
}

// length-delimited protobuf: a varint length, then that many bytes, repeated. Matches how castsnap wrote it.
function* decodeDelimited(buf) {
  let o = 0;
  while (o < buf.length) {
    let len = 0;
    let shift = 0;
    let b;
    do {
      b = buf[o++];
      len |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    yield buf.subarray(o, o + len);
    o += len;
  }
}

const hex = (u) => (u && u.length ? '0x' + Buffer.from(u).toString('hex') : '(none)');
const iso = (s) => new Date(s * 1000).toISOString();

const events = [...decodeDelimited(fs.readFileSync(file))]
  .map((b) => OnChainEvent.decode(b))
  .filter((e) => e.idRegisterEventBody)
  .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

if (!events.length) {
  console.error('The ID-registry file held no decodable id-register events.');
  process.exit(1);
}

// Walk events in on-chain order. REGISTER/TRANSFER set custody (and carry the recovery address);
// CHANGE_RECOVERY updates the recovery address. Keep the latest of each, with where it was set.
let custody;
let recovery;
for (const e of events) {
  const body = e.idRegisterEventBody;
  const when = { block: e.blockNumber, at: iso(e.blockTimestamp), tx: hex(e.transactionHash) };
  if (body.eventType === IdRegisterEventType.REGISTER || body.eventType === IdRegisterEventType.TRANSFER) {
    const event = body.eventType === IdRegisterEventType.REGISTER ? 'REGISTER' : 'TRANSFER';
    custody = { address: hex(body.to), event, ...when };
    if (body.recoveryAddress && body.recoveryAddress.length) recovery = { address: hex(body.recoveryAddress), event, ...when };
  } else if (body.eventType === IdRegisterEventType.CHANGE_RECOVERY) {
    recovery = { address: hex(body.recoveryAddress), event: 'CHANGE_RECOVERY', ...when };
  }
}

const line = (r) => (r ? `  ${r.address}\n    set by ${r.event} at ${r.at} (block ${r.block}, tx ${r.tx})` : '  (none found in these events)');

console.log(`Account control (from ${events.length} on-chain ID-registry event(s) in this export)`);
console.log('');
console.log('Custody address:');
console.log(line(custody));
console.log('');
console.log('Recovery address:');
console.log(line(recovery));
if (recovery) console.log('  Operator: unknown — this script does not resolve who controls this address.');
console.log('');
console.log('History (ID-registry events, oldest first):');
for (const e of events) {
  const body = e.idRegisterEventBody;
  let kind;
  let detail;
  if (body.eventType === IdRegisterEventType.REGISTER || body.eventType === IdRegisterEventType.TRANSFER) {
    kind = body.eventType === IdRegisterEventType.REGISTER ? 'REGISTER' : 'TRANSFER';
    detail = `custody=${hex(body.to)}  recovery=${hex(body.recoveryAddress)}`;
  } else if (body.eventType === IdRegisterEventType.CHANGE_RECOVERY) {
    kind = 'CHANGE_RECOVERY';
    detail = `recovery=${hex(body.recoveryAddress)}`;
  } else {
    kind = `type ${body.eventType}`;
    detail = '';
  }
  console.log(`  ${iso(e.blockTimestamp)}  block ${e.blockNumber}  ${kind}  ${detail}`.trimEnd());
}
console.log('');
console.log('What this shows: the addresses on record for this FID — the custody address that holds');
console.log('it, and the recovery address that can recover (move) it.');
console.log('What it does NOT show: who controls those addresses. A recovery address is often a');
console.log('contract. To find who controls it, look up its owner() on a block explorer; if that');
console.log("owner is a Safe multisig, check the Safe's owners and threshold there too.");
console.log('');
console.log('These are the latest values in this export. If on-chain event pagination was not');
console.log('exhausted, they may be stale. A recovery can move the FID to a new custody address');
console.log('instantly (FIP-5). This script reads only the id-register file above; it makes no');
console.log('network calls and writes nothing.');
