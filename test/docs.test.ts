// The docs agree with each other and with the code: README's quick-start commands appear in
// docs/QUICKSTART.md, every `node bin/castsnap.js` line uses a command and flags from cli.ts's usage
// text, every relative link names a file and heading that exist, and every "**Node NN or newer**"
// matches package.json's engines.node. No request leaves the machine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { anchors } from './anchors.ts';

const repo = path.join(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n');
const DOCS = ['README.md', ...fs.readdirSync(path.join(repo, 'docs')).filter((f) => f.endsWith('.md')).sort().map((f) => `docs/${f}`)];

// The lines inside fenced blocks, indented or not, with each block's language.
function fenced(lines: string[]): { lang: string; line: string }[] {
  const out: { lang: string; line: string }[] = [];
  let lang: string | null = null;
  for (const l of lines) {
    const m = /^\s*```(\S*)\s*$/.exec(l);
    if (m) lang = lang === null ? m[1] : null;
    else if (lang !== null) out.push({ lang, line: l });
  }
  return out;
}

// The lines outside fenced blocks.
function prose(lines: string[]): string[] {
  const out: string[] = [];
  let fence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) fence = !fence;
    else if (!fence) out.push(l);
  }
  return out;
}

test("README's quick-start commands are, line for line, in QUICKSTART's fences of the same language", (t) => {
  const readme = read('README.md').split('\n');
  const start = readme.indexOf('## Quick start');
  assert.ok(start >= 0, 'README.md has no "## Quick start" heading');
  let end = readme.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end < 0) end = readme.length;
  const lines = fenced(readme.slice(start, end)).filter((f) => f.line.trim() !== '');
  const quick = new Set(fenced(read('docs/QUICKSTART.md').split('\n')).map((f) => `${f.lang}\n${f.line.trim()}`));
  const missing = lines.filter((f) => !quick.has(`${f.lang}\n${f.line.trim()}`)).map((f) => `${f.lang}: ${f.line.trim()}`);
  t.diagnostic(`quick-start lines: ${lines.length}`);
  assert.equal(lines.length, 7, 'README.md quick start: expected 7 fenced command lines');
  assert.deepEqual(missing, []);
});

test('every node bin/castsnap.js line in README and docs uses a command and only flags from cli.ts usage', (t) => {
  const usage = new Map<string, Set<string>>();
  for (const l of read('src/cli.ts').split('\n')) {
    const m = /^ +castsnap (\S+)(.*)$/.exec(l);
    if (m) usage.set(m[1], new Set(m[2].match(/--[A-Za-z0-9-]+/g) ?? []));
  }
  assert.deepEqual([...usage.keys()].sort(), ['auth-check', 'export', 'find', 'verify']);
  const problems: string[] = [];
  let found = 0;
  for (const rel of DOCS) {
    for (const { line } of fenced(read(rel).split('\n'))) {
      const words = line.trim().split(/\s+/);
      if (words[0] !== 'node' || words[1] !== 'bin/castsnap.js') continue;
      found++;
      const flags = usage.get(words[2] ?? '');
      if (!flags) {
        problems.push(`${rel}: no command from usage in: ${line.trim()}`);
        continue;
      }
      for (const w of words.slice(3)) {
        const flag = w.split('=')[0];
        if (flag.startsWith('--') && !flags.has(flag)) problems.push(`${rel}: ${words[2]} has no ${flag}`);
      }
    }
  }
  t.diagnostic(`node bin/castsnap.js lines: ${found}`);
  assert.ok(found >= 17, `expected at least 17 node bin/castsnap.js lines, found ${found}`);
  assert.deepEqual(problems, []);
});

test('every relative link in README and docs names a file that exists and, after #, a heading in it', (t) => {
  const problems: string[] = [];
  let links = 0;
  let withAnchor = 0;
  for (const rel of DOCS) {
    for (const l of prose(read(rel).split('\n'))) {
      for (const m of l.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)\)/g)) {
        const link = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
        links++;
        const [target, anchor] = link.split('#');
        const file = target ? path.resolve(path.dirname(path.join(repo, rel)), decodeURIComponent(target)) : path.join(repo, rel);
        if (!fs.existsSync(file)) {
          problems.push(`${rel}: ${link} names no file`);
          continue;
        }
        if (anchor === undefined) continue;
        withAnchor++;
        if (!anchors(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).has(anchor)) problems.push(`${rel}: ${link} names no heading`);
      }
    }
  }
  t.diagnostic(`relative links: ${links}, with an anchor: ${withAnchor}`);
  assert.ok(links > 0 && withAnchor > 0, 'no relative links found');
  assert.deepEqual(problems, []);
});

test("every **Node NN or newer** in README, USAGE and QUICKSTART matches package.json's engines.node", () => {
  const engines = JSON.parse(read('package.json')).engines.node;
  assert.equal(engines, '>=24');
  for (const rel of ['README.md', 'docs/USAGE.md', 'docs/QUICKSTART.md']) {
    const found = [...read(rel).matchAll(/\*\*Node (\d+) or newer\*\*/g)].map((m) => `>=${m[1]}`);
    assert.ok(found.length >= 1, `${rel}: no **Node NN or newer**`);
    for (const f of found) assert.equal(f, engines, `${rel}: **Node ${f.slice(2)} or newer** but engines.node is ${engines}`);
  }
});
