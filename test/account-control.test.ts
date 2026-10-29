// The account-control helper (scripts/print-account-control.mjs) prints the custody and recovery
// address on record for an export, read offline from its on-chain ID-registry events. This test
// builds a SYNTHETIC id-register .pb fixture — made-up, obviously-fake addresses, no real account
// and no network — using the repo's own delimited framing, and runs the script against it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { IdRegisterEventType, OnChainEvent, OnChainEventType } from '@farcaster/core';
import { encodeDelimited } from '../src/writer.ts';

const repo = path.join(import.meta.dirname, '..');
const SCRIPT = 'scripts/print-account-control.mjs';

// Synthetic, obviously-fake values — never a real account.
const bytes = (byte: number, len: number) => new Uint8Array(len).fill(byte);
const CUSTODY = bytes(0x11, 20);
const RECOVERY_1 = bytes(0x22, 20);
const RECOVERY_2 = bytes(0x33, 20);
const hex = (u: Uint8Array) => '0x' + Buffer.from(u).toString('hex');

type EventSpec = {
  eventType: IdRegisterEventType;
  to?: Uint8Array;
  recoveryAddress?: Uint8Array;
  blockNumber: number;
  blockTimestamp: number;
  txByte: number;
};

function idRegisterEvent(s: EventSpec) {
  return OnChainEvent.create({
    type: OnChainEventType.EVENT_TYPE_ID_REGISTER,
    chainId: 10,
    blockNumber: s.blockNumber,
    blockTimestamp: s.blockTimestamp,
    transactionHash: bytes(s.txByte, 32),
    logIndex: 0,
    fid: 999999,
    idRegisterEventBody: {
      to: s.to ?? new Uint8Array(),
      eventType: s.eventType,
      from: new Uint8Array(),
      recoveryAddress: s.recoveryAddress ?? new Uint8Array(),
    },
  });
}

function writeFixture(specs: EventSpec[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcx-acctrl-'));
  fs.mkdirSync(path.join(dir, 'raw/protocol'), { recursive: true });
  const pb = encodeDelimited(specs.map((s) => OnChainEvent.encode(idRegisterEvent(s)).finish()));
  fs.writeFileSync(path.join(dir, 'raw/protocol/onchain-events-id-register.pb'), pb);
  return dir;
}

function runScript(args: string[]): { code: number | null; out: string } {
  const p = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', timeout: 20_000 });
  return { code: p.status, out: p.stdout + p.stderr };
}

test('prints custody and the latest recovery from a synthetic export, with history and non-overclaiming wording', () => {
  // REGISTER sets custody + recovery_1; a later CHANGE_RECOVERY moves the recovery to recovery_2.
  const dir = writeFixture([
    { eventType: IdRegisterEventType.REGISTER, to: CUSTODY, recoveryAddress: RECOVERY_1, blockNumber: 100, blockTimestamp: 1_700_000_000, txByte: 0xa1 },
    { eventType: IdRegisterEventType.CHANGE_RECOVERY, recoveryAddress: RECOVERY_2, blockNumber: 200, blockTimestamp: 1_710_000_000, txByte: 0xb2 },
  ]);
  try {
    const r = runScript([dir]);
    assert.equal(r.code, 0, r.out);
    // custody is the REGISTER address; the current recovery is the LATER one, not recovery_1.
    assert.match(r.out, new RegExp(`Custody address:\\s*\\n\\s*${hex(CUSTODY)}`));
    assert.match(r.out, new RegExp(`Recovery address:\\s*\\n\\s*${hex(RECOVERY_2)}`));
    assert.match(r.out, /set by CHANGE_RECOVERY/);
    // the original recovery still appears in the history section.
    assert.ok(r.out.includes(hex(RECOVERY_1)), 'history should still show the original recovery address');
    assert.match(r.out, /History \(ID-registry events, oldest first\)/);
    // non-overclaiming wording.
    assert.match(r.out, /Operator: unknown/);
    assert.match(r.out, /owner\(\)/);
    assert.match(r.out, /Safe/);
    assert.match(r.out, /FIP-5/);
    assert.match(r.out, /network calls and writes nothing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exits 64 with a usage line when no export dir is given', () => {
  const r = runScript([]);
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /usage: node scripts\/print-account-control\.mjs/);
});

test('exits 1 when the export has no id-register events file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcx-acctrl-empty-'));
  try {
    const r = runScript([dir]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /No ID-registry events/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
