// Guided mode: each answer is shown only while it is one the question can use, input typed before a question
// or after Enter is counted and dropped, the printed command holds only known words, and the token is still
// read only by the hidden prompt, through readSessionToken. No real token is used and nothing leaves the
// machine: in-process rows use a stand-in terminal, and child processes get one too, with a replaced fetch.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { afterNote, argvFor, askVisible, commandLine, CONTINUE_QUESTION, EMPTY_NOTE, earlyNote, ENV_NOTE, fidQuestion, HEADER, hiddenNote, LOOKUP, LOOKUP_WIN32, MEDIA_QUESTION, MENU, NOTHING_RUN, runGuided, runQuestion } from '../src/guided.ts';

const repo = path.join(import.meta.dirname, '..');
const FAKE = 'fkQ7zx';
const DOUBLED = 'fkQ7zxfkQ7zx';
const ENTER = 'then press Enter: ';
const Q = fidQuestion(LOOKUP);
// The token prompt's texts, written out here as in prompt.test.ts, so that a change to them fails a test.
const QUESTION = 'Paste your session token, then press Enter (nothing shows while you paste): ';
const AGAIN = 'Nothing was received. To cancel, press Ctrl+C.\n';
const NOTE = (n: number) => `Ignored ${n} characters typed or pasted before this prompt was ready; they weren't used or sent. If that was your token, it may still show above, so close this window when you're done.`;

// A stand-in terminal, as in prompt.test.ts, that also holds input sent while it is paused or has no 'data'
// listener, and delivers it in order at resume(), as a terminal does. `hooks.onRaw` sees each setRawMode call.
function fakeTerminal() {
  const raw: boolean[] = [];
  const held: string[] = [];
  let paused = true;
  const hooks = { onRaw: (_on: boolean): void => {} };
  const events = new EventEmitter();
  const deliver = (): void => {
    while (!paused && events.listenerCount('data') && held.length) events.emit('data', held.shift());
  };
  const stdin = Object.assign(events, {
    isTTY: true,
    setRawMode(on: boolean): void {
      raw.push(on);
      hooks.onRaw(on);
    },
    setEncoding(): void {},
    pause(): void {
      paused = true;
    },
    resume(): void {
      paused = false;
      setImmediate(deliver);
    },
    send(s: string): void {
      held.push(s);
      deliver();
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
  return { stdin, out, raw, hooks };
}
type Term = ReturnType<typeof fakeTerminal>;
const io = (term: Term) => ({ stdin: term.stdin as unknown as NodeJS.ReadStream, out: term.out as unknown as NodeJS.WriteStream, earlyMs: 20 });
const ask = (term: Term, q = Q, allowed = /[0-9]/, max = 12) => askVisible(q, allowed, max, io(term).stdin, io(term).out, 20);
const guide = (term: Term, platform: NodeJS.Platform = 'darwin', env: NodeJS.ProcessEnv = {}) => runGuided({ ...io(term), platform, env });

// Sends chunks one at a time, each on its own turn of the event loop.
function sendChunks(term: Term, chunks: string[]): void {
  setImmediate(() => {
    const [c, ...rest] = chunks;
    if (c === undefined) return;
    term.stdin.send(c);
    sendChunks(term, rest);
  });
}

// Answers each question (a write that ends with ENTER) with the next answer; an array is sent as separate chunks.
function answer(term: Term, ...answers: (string | string[])[]): void {
  term.out.onWrite = (s) => {
    if (!s.endsWith(ENTER)) return;
    const a = answers.shift();
    if (a !== undefined) sendChunks(term, typeof a === 'string' ? [a] : a);
  };
}

test('guided row 1: each menu path gives the exact argv, or null when declined', { timeout: 5_000 }, async () => {
  const paths: [string[], string[] | null][] = [
    [['1\r', '11\r', 'y\r', 'y\r'], ['export', '--fid', '11']],
    [['1\r', '11\r', 'n\r', 'y\r'], ['export', '--fid', '11', '--media', 'none']],
    [['2\r', '11\r', 'y\r', 'y\r', 'y\r'], ['export', '--fid', '11', '--private']],
    [['2\r', '11\r', 'n\r', 'y\r', 'y\r'], ['export', '--fid', '11', '--private', '--media', 'none']],
    [['3\r', '11\r', 'y\r', 'y\r'], ['auth-check', '--fid', '11']],
    [['3\r', '11\r', 'n\r'], null],
    [['1\r', '11\r', 'y\r', 'n\r'], null],
  ];
  for (const [answers, argv] of paths) {
    const term = fakeTerminal();
    answer(term, ...answers, 'y\r');
    assert.deepEqual(await guide(term), argv, JSON.stringify(answers));
  }
});

test('guided row 2: an answer with a character it can not use shows none of it, and the note counts it', { timeout: 5_000 }, async () => {
  const term = fakeTerminal();
  answer(term, `${FAKE}\r`, '11\r', '11\r');
  assert.equal(await ask(term), '11');
  assert.equal(term.out.text, `${Q}${hiddenNote(6)}${Q}11\n`);
  assert.ok(!term.out.text.includes(FAKE));

  // A digit typed first is shown, then erased when the next chunk makes the answer invalid.
  const typed = fakeTerminal();
  answer(typed, ['1', `${FAKE}\r`], '11\r', '11\r');
  assert.equal(await ask(typed), '11');
  assert.equal(typed.out.text, `${Q}1\b \b${hiddenNote(7)}${Q}11\n`);
});

test('guided row 3: an empty answer asks again once, with no default', { timeout: 5_000 }, async () => {
  const term = fakeTerminal();
  answer(term, '\r', '11\r', '11\r');
  assert.equal(await ask(term), '11');
  assert.equal(term.out.text, `${Q}${EMPTY_NOTE}${Q}11\n`);
});

test('guided row 4: input waiting when the question takes the terminal is discarded and counted', { timeout: 5_000 }, async () => {
  const term = fakeTerminal();
  term.stdin.send(FAKE);
  answer(term, '11\r', '11\r');
  assert.equal(await ask(term), '11');
  assert.equal(term.out.text, `${earlyNote(6)}${Q}11\n`);
});

test('guided row 5: input after Enter in the same chunk is counted and dropped', { timeout: 5_000 }, async () => {
  const term = fakeTerminal();
  answer(term, `11\r${FAKE}`, '11\r');
  assert.equal(await ask(term), '11');
  assert.equal(term.out.text, `${Q}11\n${afterNote(6)}`);
});

test('guided row 6: raw mode ends off on success and on Ctrl+C, and Ctrl+C rejects', { timeout: 5_000 }, async () => {
  const term = fakeTerminal();
  answer(term, '11\r', '11\r');
  assert.equal(await ask(term), '11');
  assert.deepEqual(term.raw, [true, false]);

  // The Enter after Ctrl+C must never be read.
  const cancel = fakeTerminal();
  answer(cancel, ['1\u0003', '\r'], '11\r');
  await assert.rejects(ask(cancel), /Cancelled/);
  assert.equal(cancel.out.text, `${Q}1\n`);
  assert.deepEqual(cancel.raw, [true, false]);
});

// Child processes run with HOME set to an empty temporary folder and no FC_SESSION_TOKEN.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'castsnap-guided-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
function run(args: string[], ...preloads: string[]): { code: number | null; out: string } {
  const imports = preloads.flatMap((p) => ['--import', `data:text/javascript,${encodeURIComponent(p)}`]);
  const p = spawnSync(process.execPath, [...imports, 'bin/castsnap.js', ...args], { cwd: repo, env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8', timeout: 20_000 });
  return { code: p.status, out: p.stdout + p.stderr };
}

// Records which protocol libraries a child process resolves, and prints them at exit (from prompt.test.ts).
const HEAVY = `import { registerHooks } from 'node:module';
import { writeSync } from 'node:fs';
const seen = new Set();
registerHooks({ resolve(s, c, next) { if (/^(@farcaster\\/|ajv(\\/|$))/.test(s)) seen.add(s); return next(s, c); } });
process.on('exit', () => writeSync(2, 'heavy modules: ' + ([...seen].join(' ') || 'none') + '\\n'));`;

// Each question's last line, which the child's terminal answers by.
const LAST = {
  menu: 'Type 1, 2 or 3, then press Enter: ',
  fid: 'Your FID (digits only), then press Enter: ',
  media: 'Download images and other media too? y or n, then press Enter: ',
  cont: 'Continue? y or n, then press Enter: ',
  run: 'Run it now? y or n, then press Enter: ',
  token: QUESTION,
};
type Plan = { [K in keyof typeof LAST]?: (string | string[])[] };
const AUTH: Plan = { menu: ['3\r'], fid: ['11\r'], cont: ['y\r'], run: ['y\r'] };

// A stand-in terminal for a child process, from prompt.test.ts's, with both stdin and stderr terminals. Each
// time a write ends with a question's last line, that question's next answer arrives 50 ms later, an array's
// chunks 5 ms apart. Input sent while it is paused or has no 'data' listener is held until resume(). At exit
// it prints its setRawMode, resume and pause calls, and the 'data' and 'keypress' listener counts at each
// token question. fetch prints each path it is asked for and answers 401.
const terminal = (plan: Plan) => `import { EventEmitter } from 'node:events';
import { writeSync } from 'node:fs';
const t = new EventEmitter();
const plan = ${JSON.stringify(Object.entries(plan).map(([k, v]) => [LAST[k as keyof typeof LAST], (v ?? []).map((a) => (typeof a === 'string' ? [a] : a))]))};
const log = [];
const counts = [];
const held = [];
let paused = true;
const deliver = () => { while (!paused && t.listenerCount('data') && held.length) t.emit('data', held.shift()); };
const send = (s) => { held.push(s); deliver(); };
Object.assign(t, { isTTY: true, setEncoding() {},
  setRawMode(on) { log.push('raw:' + on); },
  pause() { paused = true; log.push('pause'); },
  resume() { paused = false; log.push('resume'); setImmediate(deliver); } });
Object.defineProperty(process, 'stdin', { configurable: true, get: () => t });
Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
for (const s of [process.stdout, process.stderr]) {
  const w = s.write.bind(s);
  s.write = (x, ...a) => {
    const text = String(x);
    if (text.endsWith(${JSON.stringify(QUESTION)})) counts.push('data=' + t.listenerCount('data') + ' keypress=' + t.listenerCount('keypress'));
    const next = plan.find(([q, qs]) => text.endsWith(q) && qs.length);
    if (next) next[1].shift().forEach((c, i) => setTimeout(() => send(c), 50 + 5 * i));
    return w(x, ...a);
  };
}
process.on('exit', () => writeSync(2, '\\ntty: ' + log.join(' ') + '\\nlisteners: ' + counts.join(' | ') + '\\n'));
globalThis.fetch = async (u) => {
  writeSync(2, 'fetch ' + new URL(String(u)).pathname + '\\n');
  return new Response('{}', { status: 401 });
};`;

test('guided row 7: guide to auth-check leaves the token prompt the only reader of the terminal', () => {
  const r = run(['guide'], terminal({ ...AUTH, token: [`${FAKE}\r`] }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^listeners: data=1 keypress=0$/m);
  assert.match(r.out, /too short/);
  assert.doesNotMatch(r.out, /^fetch /m);
  assert.ok(!r.out.includes(FAKE));
});

test('guided row 8: after guided mode the token is read by the unchanged hidden prompt', () => {
  const r = run(['guide'], terminal({ ...AUTH, token: ['\r', `${FAKE}\r`] }));
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(`${QUESTION}${AGAIN}${QUESTION}6 characters received.\n`), r.out);
  assert.match(r.out, /too short/);
  assert.doesNotMatch(r.out, /^fetch /m);
  assert.ok(!r.out.includes(FAKE));
  // Four questions and the token prompt each took the terminal and gave it back paused.
  assert.ok(r.out.includes(`\ntty: ${Array(5).fill('raw:true resume raw:false pause').join(' ')}\n`), r.out);
});

test('guided row 9: input typed just after the last answer is counted by the token prompt, not used', () => {
  const r = run(['guide'], terminal({ ...AUTH, run: [['y\r', FAKE]], token: [`${FAKE}\r`] }));
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(`\n${NOTE(6)}\n${QUESTION}6 characters received.\n`), r.out);
  assert.match(r.out, /too short/);
  assert.doesNotMatch(r.out, /^fetch /m);
  assert.ok(!r.out.includes(FAKE));
});

test('guided row 10: a token pasted twice after guided mode is refused before any request', () => {
  const r = run(['guide'], terminal({ ...AUTH, token: [`${DOUBLED}\r`] }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /looks pasted twice/);
  assert.doesNotMatch(r.out, /^fetch /m);
  assert.ok(!r.out.includes(FAKE));
});

test('guided row 11: option 2 shows the token prompt before the protocol libraries load', () => {
  const r = run(['guide'], HEAVY, terminal({ menu: ['2\r'], fid: ['11\r'], media: ['y\r'], cont: ['y\r'], run: ['y\r'], token: [`${FAKE}\r`] }));
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(`${QUESTION}6 characters received.\n`), r.out);
  assert.match(r.out, /^heavy modules: none$/m);
  assert.doesNotMatch(r.out, /^fetch /m);
});

test('guided row 12: with piped stdin, guide exits 64 and asks nothing, and bare castsnap prints usage', () => {
  const g = run(['guide']);
  assert.equal(g.code, 64, g.out);
  assert.match(g.out, /^guided mode needs a terminal; see castsnap --help$/m);
  assert.doesNotMatch(g.out, /castsnap guided mode\.|press Enter/);

  const bare = run([]);
  assert.equal(bare.code, 64, bare.out);
  assert.match(bare.out, /^ {2}castsnap guide$/m);
  assert.doesNotMatch(bare.out, /castsnap guided mode\.|press Enter/);
});

test('guided row 13: an argument after guide is refused with 64 and not echoed', () => {
  const r = run(['guide', FAKE]);
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /^unknown argument, not shown in case it is your session token\./m);
  assert.ok(!r.out.includes(FAKE));
});

test('guided row 14: the command is printed once, exactly, and FC_SESSION_TOKEN shows by name only', { timeout: 5_000 }, async () => {
  const term = fakeTerminal();
  answer(term, '2\r', '11\r', 'y\r', 'y\r', 'n\r', 'n\r');
  assert.equal(await guide(term, 'darwin', { FC_SESSION_TOKEN: 'fkEnv9' }), null);
  const command = 'node bin/castsnap.js export --fid 11 --private';
  assert.equal(term.out.text, `${HEADER}${MENU}2\n${Q}11\n${MEDIA_QUESTION}y\n${CONTINUE_QUESTION}y\n${ENV_NOTE}${runQuestion(command)}n\n${NOTHING_RUN}`);
  assert.equal(term.out.text.split('node bin/castsnap.js').length, 2);
  assert.ok(term.out.text.includes('FC_SESSION_TOKEN is set'));
  assert.ok(!term.out.text.includes('fkEnv9'));
});

test('guided row 15: Backspace and Delete erase, and a \\r\\n split across chunks answers nothing', { timeout: 5_000 }, async () => {
  for (const del of ['\b', '\u007f']) {
    const term = fakeTerminal();
    answer(term, `1${del}2\r`, '3\r');
    assert.equal(await ask(term, MENU, /[1-3]/, 1), '2');
    assert.equal(term.out.text, `${MENU}1\b \b2\n`);
  }

  // Question 1 gets 1\r; the \n comes 5 ms after the next question takes the terminal, and that question's
  // answer only after it.
  const term = fakeTerminal();
  let lf = false;
  const answers = ['11\r', 'y\r', 'y\r', 'y\r'];
  term.hooks.onRaw = (on) => {
    if (on && term.raw.filter(Boolean).length === 2)
      setTimeout(() => {
        lf = true;
        term.stdin.send('\n');
      }, 5);
  };
  term.out.onWrite = (s) => {
    if (s === MENU) sendChunks(term, ['1\r']);
    else if (s.endsWith(ENTER) && lf) {
      const a = answers.shift();
      if (a !== undefined) sendChunks(term, [a]);
    }
  };
  assert.deepEqual(await guide(term), ['export', '--fid', '11']);
  assert.equal(term.out.text, `${HEADER}${MENU}1\n${earlyNote(1)}${Q}11\n${MEDIA_QUESTION}y\n${runQuestion('node bin/castsnap.js export --fid 11')}y\n`);
});

test("guided row 16: the FID hints are README's two lookup commands, and win32 gets the PowerShell one", { timeout: 5_000 }, async () => {
  const fenced: Record<string, string[]> = {};
  let lang: string | null = null;
  for (const line of fs.readFileSync(path.join(repo, 'README.md'), 'utf8').split('\n')) {
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) lang = lang === null ? (fence[1] ?? '').trim() : null;
    else if (lang !== null && line.includes('userNameProofByName')) (fenced[lang] ??= []).push(line.trim());
  }
  assert.deepEqual(Object.keys(fenced).sort(), ['bash', 'powershell']);
  assert.deepEqual(fenced.bash, [LOOKUP]);
  assert.deepEqual(fenced.powershell, [LOOKUP_WIN32]);

  const term = fakeTerminal();
  answer(term, '1\r', '11\r', 'y\r', 'n\r', 'n\r');
  assert.equal(await guide(term, 'win32'), null);
  assert.ok(term.out.text.includes(fidQuestion(LOOKUP_WIN32)));
});

test('guided row 17: the printed command holds only known words, and every argv argvFor makes is accepted', () => {
  for (const word of ['--out', '--allow-unsafe-location', '--hub', '--base', '~/out', 'EXPORT']) {
    assert.throws(() => commandLine(['export', '--fid', '11', word]), /^Error: guided mode built a word it does not allow$/, word);
  }
  for (const command of ['export', 'auth-check'] as const) {
    for (const priv of [false, true]) {
      for (const mediaNone of [false, true]) {
        for (const fid of [1, 11, 999_999_999_999]) {
          const argv = argvFor({ command, fid, private: priv, mediaNone });
          assert.equal(commandLine(argv), `node bin/castsnap.js ${argv.join(' ')}`);
        }
      }
    }
  }
});
