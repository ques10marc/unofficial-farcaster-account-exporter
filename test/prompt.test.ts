// The hidden token prompt, in castsnap and in quick capture: input typed before the prompt is ready is
// discarded and counted, the answer is shown only as a character count, a value pasted twice is refused
// before any request, and castsnap shows the prompt before loading the protocol libraries. No real token
// is used and nothing leaves the machine: child processes get a replaced fetch and --base on a closed
// loopback port.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { checkTokenShape, promptHidden, readSessionToken } from '../src/secrets.ts';

const repo = path.join(import.meta.dirname, '..');
const sentinel = () => `castsnap-sentinel-${randomUUID()}`;

// A stand-in terminal for promptHidden. `pending` was typed before the prompt took the terminal, so it
// arrives right after resume(), as buffered input does. `onWrite` sees each write the prompt makes.
function fakeTerminal(pending: string) {
  const raw: boolean[] = [];
  const events = new EventEmitter();
  const stdin = Object.assign(events, {
    isTTY: true,
    setRawMode(on: boolean): void {
      raw.push(on);
    },
    setEncoding(): void {},
    pause(): void {},
    resume(): void {
      if (pending) setImmediate(() => events.emit('data', pending));
    },
  });
  const out = {
    text: '',
    onWrite: (_s: string): void => {},
    write(s: string): boolean {
      this.text += s;
      this.onWrite(s);
      return true;
    },
  };
  const ask = (q: string) => promptHidden(q, stdin as unknown as NodeJS.ReadStream, out as unknown as NodeJS.WriteStream, 20);
  return { stdin, out, raw, ask };
}

test('prompt: input typed before the prompt is discarded and counted, and the answer is shown only as a length', async () => {
  const t = sentinel();
  const term = fakeTerminal('early-paste');
  term.out.onWrite = (s) => {
    if (s === 'Q: ') setImmediate(() => term.stdin.emit('data', `${t}\r`));
  };
  assert.equal(await term.ask('Q: '), t);
  assert.equal(term.out.text, `Ignored 11 characters typed or pasted before this prompt was ready. They may have been shown on screen; if that was your token, clear the terminal's scrollback.\nQ: ${t.length} characters received.\n`);
  assert.deepEqual(term.raw, [true, false]);

  // Ctrl+C cancels, even before the question appears.
  const early = fakeTerminal('\u0003');
  await assert.rejects(early.ask('Q: '), /Cancelled/);
  assert.equal(early.out.text, '\n');
});

test('token: a value pasted twice is refused before the length check, without echoing it', async () => {
  const t = sentinel();
  assert.match(checkTokenShape('fk1fk1')!, /looks pasted twice/);
  assert.match(checkTokenShape('fk1')!, /too short/);
  assert.equal(checkTokenShape(t), null);
  const message = 'Session token not usable: the token looks pasted twice (the same text two times in a row); run the command again and paste it once.';
  for (const typed of [`${t}${t}`, `Bearer ${t}Bearer ${t}`, `\x1b[200~${t}\x1b[201~\x1b[200~${t}\x1b[201~`]) {
    await assert.rejects(readSessionToken({ env: {}, prompt: async () => typed }), (e: Error) => !e.message.includes(t) && e.message === message);
  }
  await assert.rejects(readSessionToken({ env: { FC_SESSION_TOKEN: `${t}${t}` } }), /looks pasted twice/);
});

// Child processes run with HOME set to an empty temporary folder and no FC_SESSION_TOKEN, so they take the
// prompt path. `preload` is module source that runs before the program.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'castsnap-prompt-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
function run(args: string[], preload: string): { code: number | null; out: string } {
  const p = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, ...args], { cwd: repo, env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8', timeout: 20_000 });
  return { code: p.status, out: p.stdout + p.stderr };
}

// Records which protocol libraries a child process resolves, and prints them at exit.
const HEAVY = `import { registerHooks } from 'node:module';
import { writeSync } from 'node:fs';
const seen = new Set();
registerHooks({ resolve(s, c, next) { if (/^(@farcaster\\/|ajv(\\/|$))/.test(s)) seen.add(s); return next(s, c); } });
process.on('exit', () => writeSync(2, 'heavy modules: ' + ([...seen].join(' ') || 'none') + '\\n'));`;

test('castsnap shows the token prompt before it loads the protocol libraries', () => {
  for (const args of [['auth-check', '--fid', '11'], ['export', '--fid', '11', '--private']]) {
    const r = run(['bin/castsnap.js', ...args], HEAVY);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /No terminal for a hidden prompt/);
    assert.match(r.out, /^heavy modules: none$/m);
  }
  // Control: verify does load them, and the hook sees it.
  assert.match(run(['bin/castsnap.js', 'verify', path.join(home, 'no-such-export')], HEAVY).out, /^heavy modules: .*@farcaster\/core/m);
});

const FAKE = 'castsnap-fake-token-0000-1111-2222';
// A stand-in terminal for a child process: `early` is waiting when the prompt takes the terminal, and
// `typed` arrives 50 ms after the question. fetch prints each path it is asked for, and answers /v2/me
// with fid 12 for exactly `Bearer FAKE`, else 401.
const terminal = (early: string, typed: string) => `import { EventEmitter } from 'node:events';
import { writeSync } from 'node:fs';
const t = new EventEmitter();
Object.assign(t, { isTTY: true, setRawMode() {}, setEncoding() {}, pause() {}, resume() { if (${JSON.stringify(early)}) setImmediate(() => t.emit('data', ${JSON.stringify(early)})); } });
Object.defineProperty(process, 'stdin', { configurable: true, get: () => t });
for (const s of [process.stdout, process.stderr]) {
  const w = s.write.bind(s);
  s.write = (x, ...a) => { if (String(x).startsWith('Paste session token')) setTimeout(() => t.emit('data', ${JSON.stringify(typed)}), 50); return w(x, ...a); };
}
globalThis.fetch = async (u, init) => {
  writeSync(2, 'fetch ' + new URL(String(u)).pathname + '\\n');
  const ok = new Headers(init?.headers).get('authorization') === 'Bearer ${FAKE}';
  return new Response(JSON.stringify({ result: { user: { fid: 12, username: 'stub' } } }), { status: ok ? 200 : 401 });
};`;
const TOOLS: Record<string, string[]> = {
  castsnap: ['bin/castsnap.js', 'auth-check', '--fid', '11', '--base', 'http://127.0.0.1:9'],
  'quick capture': ['scripts/quick-capture.mjs', '--fid', '11', '--base', 'http://127.0.0.1:9'],
};

test('castsnap and quick capture in a stand-in terminal: early input is ignored, the answer is counted, a doubled paste sends nothing', () => {
  for (const [tool, args] of Object.entries(TOOLS)) {
    const once = run(args, terminal('fk1', `${FAKE}\r`));
    assert.equal(once.code, 1, `${tool}: ${once.out}`);
    assert.match(once.out, /Ignored 3 characters typed or pasted before this prompt was ready\./, tool);
    assert.match(once.out, /Paste session token \(input hidden\), then Enter: 34 characters received\./, tool);
    // The early input was not used: the token check saw exactly FAKE, which belongs to fid 12.
    assert.match(once.out, /belongs to fid 12, not --fid 11\./, tool);
    assert.match(once.out, /^fetch \/v2\/me$/m, tool);

    const twice = run(args, terminal('', `${FAKE}${FAKE}\r`));
    assert.equal(twice.code, 1, `${tool}: ${twice.out}`);
    assert.match(twice.out, /68 characters received\./, tool);
    assert.match(twice.out, /[Tt]he token looks pasted twice \(the same text two times in a row\); run the command again and paste it once\./, tool);
    assert.doesNotMatch(twice.out, /^fetch /m, `${tool} sent a request`);
    assert.doesNotMatch(twice.out, /Ignored/, tool);
  }
});

test('quick capture: a rejected token says to paste once before copying a fresh one', () => {
  const r = run(TOOLS['quick capture'], terminal('', 'castsnap-fake-token-9999\r'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Token check failed: \/v2\/me returned HTTP 401\. If you pasted more than once, run the command again and paste once\. If it still fails, copy a fresh token and retry\./);
});
