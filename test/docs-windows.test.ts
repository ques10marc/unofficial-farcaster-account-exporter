// The Windows commands in README and USAGE: PowerShell blocks that also work in Windows PowerShell 5.1,
// and the USAGE steps that keep the token off the clipboard history and out of the shell history.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.join(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repo, rel), 'utf8');
const DOCS = ['README.md', 'docs/USAGE.md'];

// The body of every fenced powershell block, indented or not.
function powershellBlocks(rel: string): string[] {
  const re = /^([ \t]*)```powershell[ \t]*\r?\n([\s\S]*?)^\1```[ \t]*$/gm;
  return [...read(rel).matchAll(re)].map((m) => m[2] ?? '');
}

test('README and USAGE have PowerShell blocks to check', () => {
  for (const rel of DOCS) assert.ok(powershellBlocks(rel).length >= 1, `${rel}: no powershell block found`);
});

test('PowerShell blocks call curl.exe, never curl', () => {
  for (const rel of DOCS) {
    const blocks = powershellBlocks(rel);
    assert.ok(blocks.some((b) => b.includes('curl.exe -s "')), `${rel}: no powershell block calls curl.exe`);
    for (const b of blocks) assert.doesNotMatch(b, /\bcurl\b(?!\.exe)/, `${rel}: a powershell block calls curl, which Windows PowerShell 5.1 runs as Invoke-WebRequest`);
  }
});

test('PowerShell blocks have no ~/, no &&, no -MaskInput and no typed token', () => {
  for (const rel of DOCS) {
    for (const b of powershellBlocks(rel)) {
      assert.doesNotMatch(b, /~[/\\]/, `${rel}: a powershell block uses ~ in a path`);
      assert.ok(!b.includes('&&'), `${rel}: a powershell block uses &&, which Windows PowerShell 5.1 lacks`);
      assert.ok(!b.includes('-MaskInput'), `${rel}: a powershell block uses -MaskInput, which PowerShell 7 lacks`);
      assert.doesNotMatch(b, /\$env:FC_SESSION_TOKEN\s*=\s*['"]/, `${rel}: a powershell block types the token into the command line`);
    }
  }
});

test('USAGE has the PowerShell token, hash and clipboard steps', () => {
  const usage = read('docs/USAGE.md');
  for (const s of ['-AsSecureString', 'Remove-Item Env:FC_SESSION_TOKEN', 'Get-FileHash', 'clipboard history', 'across devices']) {
    assert.ok(usage.includes(s), `docs/USAGE.md lacks ${s}`);
  }
});
