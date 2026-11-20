import { EARLY_INPUT_MS, redactRegistered, TOKEN_ENV, tokenFromEnv } from './secrets.ts';

// What guided mode prints. Each question goes to stderr, and none has
// a default. READ_FIRST is R52's text, verbatim.
const chars = (n: number): string => `${n} character${n === 1 ? '' : 's'}`;

export const HEADER = 'castsnap guided mode. Press Ctrl+C at any time to cancel.\n';

export const MENU = `
What do you want to do?
  1  Export your public data
  2  Export your public and private data (bookmarks, DMs, drafts;
     needs your session token)
  3  Check your session token only (writes nothing)
Type 1, 2 or 3, then press Enter: `;

// README.md's two lookup commands: the first from a bash fence, the
// second from a powershell fence (row 16 holds them equal).
export const LOOKUP = "curl -s 'https://snap.farcaster.xyz:3381/v1/userNameProofByName?name=YOUR_USERNAME'";
export const LOOKUP_WIN32 = 'curl.exe -s "https://snap.farcaster.xyz:3381/v1/userNameProofByName?name=YOUR_USERNAME"';

export const fidQuestion = (lookup: string): string => `
Your FID is your account's number. To look it up, run this in another
window, with your username in place of YOUR_USERNAME, and read the
"fid" value:
  ${lookup}
Your FID (digits only), then press Enter: `;

export const NOT_FID = "That isn't an FID.\n";

export const MEDIA_QUESTION = `
Download images and other media too? y or n, then press Enter: `;

export const READ_FIRST = `Read first:
- Only your own data: castsnap checks that the token belongs to this
  FID before it writes anything, and stops if it doesn't.
- It may stop working: castsnap uses the Farcaster app's
  undocumented endpoints, which may stop working or be blocked at
  any time, and you run it under the app's current terms.
- Your session token works like a password: while it is valid, it
  gives full access to your account. Paste it only into castsnap's
  hidden prompt. Anyone who asks you for it is trying to take over
  your account.
- castsnap keeps the token in memory only, and sends it only to
  https://client.farcaster.xyz or https://farcaster.xyz/~api, never
  along a redirect.
- Signing out does not revoke a copied token.
- Copying the token puts it on your clipboard, where clipboard
  history or a shared clipboard can keep it.
- Your export will contain your DMs: keep it out of git and cloud
  sync.
- castsnap never asks for your seed phrase or recovery phrase.
The full list is in README.md, under "Private data".
`;

export const CONTINUE_QUESTION = `
${READ_FIRST}Continue? y or n, then press Enter: `;

export const ENV_NOTE = `
${TOKEN_ENV} is set, so castsnap will use it and won't ask for a token.
`;

export const runQuestion = (command: string): string => `
The same command, to run it yourself later:
  ${command}
Run it now? y or n, then press Enter: `;

export const NOTHING_RUN = 'Nothing was run.\n';

// askVisible's own lines.
export const NO_TERMINAL = 'guided mode needs a terminal';
export const earlyNote = (n: number): string =>
  `Ignored ${chars(n)} typed before this question; they weren't used or sent.\n`;
export const hiddenNote = (n: number): string => `
${chars(n)} not shown; if that was your token, it wasn't used or sent.
Type the answer again.
`;
export const EMPTY_NOTE = `
Nothing was entered. To cancel, press Ctrl+C.
`;
export const afterNote = (n: number): string =>
  `Ignored ${chars(n)} typed after Enter; they weren't used or sent.\n`;

// Guided mode needs both ends to be terminals: stdin for the answers, stderr for the questions.
export function canGuide(stdin: NodeJS.ReadStream = process.stdin, err: NodeJS.WriteStream = process.stderr): boolean {
  return Boolean(stdin.isTTY && err.isTTY);
}

// Reads one short answer from the terminal, modelled on promptHidden (secrets.ts). Raw mode; input in the
// first earlyMs is counted and dropped, then the question appears. While the answer is valid, each allowed
// character up to maxLength is echoed, and Backspace or Delete erases the last one. The first character
// outside the allowed set, or past maxLength, makes the answer invalid: whatever is on screen is erased,
// nothing more is echoed, and at Enter the question is asked again. Echo is held while a chunk is read, so a
// chunk that makes the answer invalid shows none of itself. An empty answer asks again; Ctrl+C cancels.
export function askVisible(question: string, allowed: RegExp, maxLength: number, stdin: NodeJS.ReadStream = process.stdin, out: NodeJS.WriteStream = process.stderr, earlyMs = EARLY_INPUT_MS): Promise<string> {
  if (!stdin.isTTY) return Promise.reject(new Error(NO_TERMINAL));
  return new Promise((resolve, reject) => {
    let buf = '';
    let held = '';
    let onScreen = 0;
    let invalid = false;
    let typed = 0;
    let early = 0;
    let ready = false;
    let afterCr = false;
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      if (!held) return;
      out.write(held);
      held = '';
      onScreen = buf.length;
    };
    const write = (s: string) => {
      flush();
      out.write(s);
    };
    const reset = () => {
      buf = '';
      held = '';
      onScreen = 0;
      invalid = false;
      typed = 0;
    };
    const finish = (err?: Error, after = 0) => {
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      write('\n');
      if (after) out.write(afterNote(after));
      if (err) reject(err);
      else resolve(buf);
    };
    const onData = (chunk: string) => {
      const cs = [...chunk];
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        if (c === '\u0003') return finish(new Error('Cancelled'));
        if (!ready) {
          early++;
          continue;
        }
        const lf = c === '\n' && afterCr;
        afterCr = c === '\r';
        if (lf) continue;
        if (c === '\r' || c === '\n') {
          if (invalid) {
            write(hiddenNote(typed));
            write(question);
            reset();
            continue;
          }
          if (!buf) {
            write(EMPTY_NOTE);
            write(question);
            reset();
            continue;
          }
          let after = 0;
          for (let j = i + 1; j < cs.length; j++) if (!(j === i + 1 && c === '\r' && cs[j] === '\n')) after++;
          return finish(undefined, after);
        }
        if (c === '\b' || c === '\u007f') {
          if (invalid || !buf) continue;
          buf = buf.slice(0, -1);
          held += '\b \b';
          continue;
        }
        typed++;
        if (invalid) continue;
        if (allowed.test(c) && buf.length < maxLength) {
          buf += c;
          held += c;
          continue;
        }
        invalid = true;
        held = '';
        if (onScreen) out.write('\b \b'.repeat(onScreen));
        onScreen = 0;
      }
      flush();
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
    timer = setTimeout(() => {
      ready = true;
      if (early) out.write(earlyNote(early));
      out.write(question);
    }, earlyMs);
  });
}

// What the answers say. It has no token field: the token is read later, by main(argv), through secrets.ts.
export interface GuidedAnswers {
  command: 'export' | 'auth-check';
  fid: number;
  private: boolean;
  mediaNone: boolean;
}

export function argvFor(a: GuidedAnswers): string[] {
  return [a.command, '--fid', String(a.fid), ...(a.private ? ['--private'] : []), ...(a.mediaNone ? ['--media', 'none'] : [])];
}

// The printed command holds only these words, so every shell parses it the same way, with no quotes, and
// nothing typed at a question can reach it.
const WORDS = new Set(['export', 'auth-check', '--fid', '--private', '--media', 'none']);
const FID_WORD = /^[1-9][0-9]{0,11}$/;
export function commandLine(argv: string[]): string {
  for (const w of argv) if (!WORDS.has(w) && !FID_WORD.test(w)) throw new Error('guided mode built a word it does not allow');
  return redactRegistered(`node bin/castsnap.js ${argv.join(' ')}`);
}

export interface GuidedIo {
  stdin?: NodeJS.ReadStream;
  out?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  earlyMs?: number;
}

// Asks the questions and returns the argv to run, or null when the user declines.
export async function runGuided(io: GuidedIo = {}): Promise<string[] | null> {
  const stdin = io.stdin ?? process.stdin;
  const out = io.out ?? process.stderr;
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;
  const earlyMs = io.earlyMs ?? EARLY_INPUT_MS;
  const ask = (q: string, allowed: RegExp, max: number) => askVisible(q, allowed, max, stdin, out, earlyMs);
  const yes = async (q: string) => (await ask(q, /[ynYN]/, 1)).toLowerCase() === 'y';
  out.write(HEADER);
  const choice = await ask(MENU, /[1-3]/, 1);
  const lookup = platform === 'win32' ? LOOKUP_WIN32 : LOOKUP;
  let fid = Number(await ask(fidQuestion(lookup), /[0-9]/, 12));
  while (fid === 0) {
    out.write(NOT_FID);
    fid = Number(await ask(fidQuestion(lookup), /[0-9]/, 12));
  }
  const mediaNone = choice !== '3' && !(await yes(MEDIA_QUESTION));
  if (choice !== '1') {
    if (!(await yes(CONTINUE_QUESTION))) {
      out.write(NOTHING_RUN);
      return null;
    }
    if (tokenFromEnv(env)) out.write(ENV_NOTE);
  }
  const argv = argvFor({ command: choice === '3' ? 'auth-check' : 'export', fid, private: choice === '2', mediaNone });
  if (!(await yes(runQuestion(commandLine(argv))))) {
    out.write(NOTHING_RUN);
    return null;
  }
  return argv;
}
