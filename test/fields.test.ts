// docs/fields.json is the single source for what every dataset, file, field and printed line in an
// export means, and docs/FIELDS.md is generated from it (npm run fields). These tests keep the two in
// step with each other and with the code: the normalized schemas, the CSV headers, manifest keys and
// media index rows that a public and a mock --private run write, the account-status and Privacy: lines,
// D19 and D20, every src/ citation, and the links into FIELDS.md. No request leaves the machine.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FIELDS_JSON, FIELDS_MD, type FieldsJson, renderFieldsMd } from '../scripts/fields-md.ts';
import { parseCsv } from '../src/csv.ts';
import { RECONCILIATION_SCHEMA, SCHEMAS } from '../src/schemas.ts';
import { pickStatus, recordCounts, stayedCount, statusFromMe, statusFromProfile, statusLine } from '../src/status.ts';
import { replayExport } from './helpers.ts';
import { mockPrivateExport } from './private-run.ts';

type FileEntry = FieldsJson['files'][number];
type Field = FileEntry['fields'][number];
type Based = { basis: string; from?: string; sources?: string[] };
type Obj = Record<string, unknown>;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const j = JSON.parse(fs.readFileSync(FIELDS_JSON, 'utf8')) as FieldsJson;
const asObj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const entry = (p: string) => j.files.find((f) => f.path === p);
const isUrl = (s: string) => /^https?:\/\//.test(s);
const byId = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1));

// A field path as segments: records[].hash is records, [], hash.
const segs = (p: string) => p.replace(/\[\]/g, '.[]').split('.');
const matches = (pat: string[], p: string[]) => pat.length === p.length && pat.every((s, i) => s === p[i] || (s === '*' && p[i] !== '[]'));
const under = (pat: string[], p: string[]) => pat.length < p.length && pat.every((s, i) => s === p[i] || (s === '*' && p[i] !== '[]'));

// Everything that carries a basis: the about lines of datasets, files and printed lines, every field and
// every part.
function based(): [string, Based][] {
  const out: [string, Based][] = [];
  for (const d of j.datasets) d.about.forEach((a, i) => out.push([`${d.id} about[${i}]`, a]));
  for (const f of j.files) {
    f.about.forEach((a, i) => out.push([`${f.path} about[${i}]`, a]));
    for (const x of f.fields) out.push([`${f.path} ${x.path}`, x]);
  }
  for (const l of j.lines) {
    l.about.forEach((a, i) => out.push([`${l.id} about[${i}]`, a]));
    for (const x of l.parts) out.push([`${l.id} ${x.path}`, x]);
  }
  return out;
}

// Every piece of text a reader sees, with where it is.
function texts(): [string, string][] {
  const out: [string, string][] = [['title', j.title]];
  j.about.forEach((s, i) => out.push([`about[${i}]`, s]));
  for (const b of j.bases) out.push([`base ${b.id}`, b.label], [`base ${b.id}`, b.about]);
  for (const s of j.statuses) out.push([`status ${s.status}`, s.meaning]);
  for (const d of j.datasets) out.push([d.id, d.title]);
  for (const f of j.files) out.push([f.path, f.title]);
  for (const l of j.lines) {
    out.push([l.id, l.title]);
    for (const p of l.printedBy) out.push([`${l.id} printedBy`, p.where]);
  }
  for (const [where, b] of based()) {
    const t = b as Based & { text?: string; meaning?: string };
    if (t.text !== undefined) out.push([where, t.text]);
    if (t.meaning !== undefined) out.push([where, t.meaning]);
    if (t.from !== undefined) out.push([`${where} from`, t.from]);
  }
  return out;
}

// R13's phrases, written out here rather than imported, so a changed phrase in the generator is caught.
function phrase(b: Based): string {
  switch (b.basis) {
    case 'code':
      return "from castsnap's code";
    case 'app':
      return "the app's own description";
    case 'inferred':
      return `inferred from ${b.from}`;
    case 'docs':
      return `[${b.from}](${(b.sources ?? []).find(isUrl)})`;
    case 'unknown':
      return `meaning unknown (${b.from})`;
    default:
      return `(unknown basis id ${b.basis})`;
  }
}

const firstDiff = (a: string, b: string) => {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return i + 1;
  return 0;
};

test('FIELDS.md is what npm run fields writes from fields.json (CRLF read as LF)', () => {
  const md = fs.readFileSync(FIELDS_MD, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(md.startsWith('<!-- Generated from docs/fields.json'), 'FIELDS.md lost its generated header');
  assert.equal(firstDiff(md, renderFieldsMd()), 0, 'docs/FIELDS.md differs from what npm run fields writes, from this line on: run npm run fields');
});

test("FIELDS.md shows each basis only as R13's phrase for it, in every about bullet and every Basis column", () => {
  const all = based();
  const allowed = new Set(all.map(([, b]) => phrase(b)));
  const md = fs.readFileSync(FIELDS_MD, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const slots: string[] = [];
  let aboutSlots = 0;
  let col = -1;
  for (const line of md) {
    const at = line.lastIndexOf(' (Basis: ');
    if (line.startsWith('- ') && at > 0 && line.endsWith(')')) {
      slots.push(line.slice(at + ' (Basis: '.length, -1));
      aboutSlots++;
      continue;
    }
    if (!line.startsWith('|')) {
      col = -1;
      continue;
    }
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    if (col < 0) {
      col = cells.indexOf('Basis');
      continue;
    }
    if (/^-+$/.test(cells[col] ?? '')) continue;
    slots.push((cells[col] ?? '').replace(/\\\|/g, '|'));
  }
  const nAbout = all.filter(([where]) => /about\[\d+\]$/.test(where)).length;
  assert.equal(aboutSlots, nAbout, 'FIELDS.md has a different number of about bullets with a basis than fields.json has about lines');
  assert.equal(slots.length, all.length, 'FIELDS.md has a different number of basis slots than fields.json has based items');
  assert.deepEqual([...new Set(slots.filter((s) => !allowed.has(s)))], [], "basis phrases outside R13's list");
});

// The JSON Schema walk: every property is a field; an array whose items have properties adds a [] field
// and its items' fields; oneOf, anyOf and allOf branches add their fields at the same place.
function resolve(node: unknown, root: Obj): Obj | undefined {
  const n = asObj(node);
  const ref = n?.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/')) return resolve(ref.slice(2).split('/').reduce<unknown>((o, k) => asObj(o)?.[k], root), root);
  return n;
}
function variants(n: Obj, root: Obj): Obj[] {
  const branches = (['oneOf', 'anyOf', 'allOf'] as const).flatMap((k) => (Array.isArray(n[k]) ? (n[k] as unknown[]) : []));
  return [n, ...branches.map((b) => resolve(b, root)).filter((b): b is Obj => !!b).flatMap((b) => variants(b, root))];
}
function walkSchema(node: unknown, root: Obj, prefix: string, out: Set<string>): void {
  const n = resolve(node, root);
  if (!n) return;
  for (const v of variants(n, root)) {
    for (const [k, child] of Object.entries(asObj(v.properties) ?? {})) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      walkSchema(child, root, p, out);
    }
    const items = resolve(v.items, root);
    if (items && variants(items, root).some((x) => asObj(x.properties))) {
      out.add(`${prefix}[]`);
      walkSchema(items, root, `${prefix}[]`, out);
    }
  }
}

test('every normalized schema and reconciliation.json field has an entry, and no entry names a field or file the schemas lack', () => {
  const schemas: [string, Obj][] = [...Object.entries(SCHEMAS).map(([name, s]): [string, Obj] => [`normalized/${name}.json`, s]), ['reconciliation.json', RECONCILIATION_SCHEMA]];
  const normalizedEntries = j.files.map((f) => f.path).filter((p) => /^normalized\/[^/]+\.json$/.test(p));
  assert.deepEqual(normalizedEntries.sort(), Object.keys(SCHEMAS).map((n) => `normalized/${n}.json`).sort(), 'normalized/ entries differ from SCHEMAS');
  const problems: string[] = [];
  for (const [file, schema] of schemas) {
    const e = entry(file);
    if (!e) {
      problems.push(`${file}: no entry`);
      continue;
    }
    const walked = new Set<string>();
    walkSchema(schema, schema, '', walked);
    const have = new Set(e.fields.map((f) => f.path));
    const covers = e.fields.filter((f) => f.covers).map((f) => segs(f.path));
    for (const w of walked) if (!have.has(w) && !covers.some((c) => under(c, segs(w)))) problems.push(`${file}: ${w} has no entry`);
    for (const h of have) if (!walked.has(h)) problems.push(`${file}: ${h} is not in the schema`);
  }
  assert.deepEqual(problems, []);
});

// One public run (the recorded fixtures) and one mock --private run, shared by the tests below.
let runs: Promise<string[]> | undefined;
const exportDirs = () => (runs ??= Promise.all([replayExport().then((r) => r.dir), mockPrivateExport().then((r) => r.result.dir)]));

test('every CSV a public and a mock --private run write has an entry whose fields are its header, in order, and both runs together write every CSV entry', async () => {
  const seen = new Set<string>();
  for (const dir of await exportDirs()) {
    const csvDir = path.join(dir, 'csv');
    if (!fs.existsSync(csvDir)) continue;
    for (const name of fs.readdirSync(csvDir)) {
      const rel = `csv/${name}`;
      seen.add(rel);
      const e = entry(rel);
      assert.ok(e, `${rel} has no entry`);
      const header = parseCsv(fs.readFileSync(path.join(csvDir, name), 'utf8'))[0];
      assert.deepEqual(e.fields.map((f) => f.path), header, `${rel}: its fields differ from its header`);
    }
  }
  const unseen = j.files.map((f) => f.path).filter((p) => p.startsWith('csv/') && !seen.has(p));
  assert.deepEqual(unseen, [], 'CSV entries neither run wrote');
});

// The keys a value holds, as segment lists; an array of objects adds a [] segment. Arrays of any kind are
// also listed apart, so a field such as castHashes[] counts as seen.
function observe(v: unknown, at: string[], keys: string[][], arrays: string[][]): void {
  if (Array.isArray(v)) {
    if (v.length) arrays.push([...at, '[]']);
    const objs = v.filter((x) => asObj(x));
    if (objs.length) {
      keys.push([...at, '[]']);
      for (const o of objs) observe(o, [...at, '[]'], keys, arrays);
    }
    return;
  }
  for (const [k, x] of Object.entries(asObj(v) ?? {})) {
    keys.push([...at, k]);
    observe(x, [...at, k], keys, arrays);
  }
}

// Every key the runs wrote has an entry (* matches any map key; a covers entry takes everything under it).
// An entry neither run wrote is optional, and its key name occurs in a src/ file it cites.
function checkObserved(e: FileEntry, values: unknown[]): string[] {
  const keys: string[][] = [];
  const arrays: string[][] = [];
  for (const v of values) observe(v, [], keys, arrays);
  const problems: string[] = [];
  const pats = e.fields.map((f): [Field, string[]] => [f, segs(f.path)]);
  const reported = new Set<string>();
  for (const k of keys) {
    const ok = pats.some(([f, p]) => matches(p, k) || (f.covers && under(p, k)));
    const name = k.join('.');
    if (!ok && !reported.has(name)) {
      reported.add(name);
      problems.push(`${e.path}: ${name} has no entry`);
    }
  }
  for (const [f, p] of pats) {
    if (keys.some((k) => matches(p, k)) || arrays.some((k) => matches(p, k))) continue;
    if (!f.optional) {
      problems.push(`${e.path}: ${f.path} was not written by either run, and is not optional`);
      continue;
    }
    const key = p.filter((s) => s !== '*' && s !== '[]').at(-1) ?? '';
    const files = [...new Set([...(f.sources ?? []), ...e.sources].filter((s) => s.startsWith('src/')).map((s) => s.split('#')[0]))];
    if (!files.some((file) => fs.existsSync(path.join(ROOT, file)) && code(file).includes(key))) problems.push(`${e.path}: ${f.path} was not written, and ${key} occurs in none of its src/ citations`);
  }
  return problems;
}

test('every manifest.json key from a public and a mock --private run has an entry, and every entry is written or optional and in its code', async () => {
  const e = entry('manifest.json');
  assert.ok(e, 'manifest.json has no entry');
  const values = (await exportDirs()).map((dir) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as unknown);
  assert.deepEqual(checkObserved(e, values), []);
});

test('every media/index.jsonl key from the two runs has an entry, and every entry is written or optional and in its code', async () => {
  const e = entry('media/index.jsonl');
  assert.ok(e, 'media/index.jsonl has no entry');
  const rows: unknown[] = [];
  for (const dir of await exportDirs()) {
    const p = path.join(dir, 'media', 'index.jsonl');
    if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split('\n')) if (l.trim()) rows.push(JSON.parse(l));
  }
  assert.ok(rows.length > 0, 'neither run wrote a media index row');
  assert.deepEqual(checkObserved(e, rows), []);
});

test("D1 to D20 each have exactly one entry, D16, D17 and D18 are unused, and the exported IDs are SPEC's", () => {
  assert.deepEqual(
    j.datasets.map((d) => d.id),
    Array.from({ length: 20 }, (_, i) => `D${i + 1}`),
  );
  assert.deepEqual(
    j.datasets.filter((d) => d.state !== 'exported').map((d) => `${d.id} ${d.state}`),
    ['D16 unused', 'D17 unused', 'D18 unused'],
  );
  const spec = [...read('docs/SPEC.md').matchAll(/^\| (D\d+) \|/gm)].map((m) => m[1]);
  assert.deepEqual(
    j.datasets.filter((d) => d.state === 'exported').map((d) => d.id),
    spec,
    "the exported IDs differ from SPEC's dataset table",
  );
});

test("every file entry's datasets are exactly the datasets whose files list its path, and every listed path has an entry", () => {
  const problems: string[] = [];
  for (const f of j.files) {
    const listing = j.datasets.filter((d) => d.files.includes(f.path)).map((d) => d.id);
    const own = [...f.datasets].sort(byId);
    if (own.join() !== listing.sort(byId).join()) problems.push(`${f.path}: datasets ${own.join() || '-'}, listed by ${listing.join() || '-'}`);
  }
  const paths = new Set(j.files.map((f) => f.path));
  for (const d of j.datasets) for (const p of d.files) if (!paths.has(p)) problems.push(`${d.id}: ${p} has no entry`);
  assert.deepEqual(problems, []);
});

test('paths use only the NAME, NNNN, CATEGORY and ID placeholders and * segments, nothing is listed twice, and an entry with no fields has about lines', () => {
  const problems: string[] = [];
  const filePaths = j.files.map((f) => f.path);
  if (new Set(filePaths).size !== filePaths.length) problems.push('a file path has two entries');
  for (const f of j.files) {
    for (const s of f.path.replace(/\b(NAME|NNNN|CATEGORY|ID)\b/g, 'x').split('/')) if (!/^([a-z0-9][a-z0-9._-]*|SHA256SUMS)$/.test(s)) problems.push(`${f.path}: segment ${s}`);
    const fp = f.fields.map((x) => x.path);
    if (new Set(fp).size !== fp.length) problems.push(`${f.path} lists a field twice`);
    for (const p of fp) for (const s of segs(p)) if (!/^(\*|\[\]|[A-Za-z_$@][\w$@-]*)$/.test(s)) problems.push(`${f.path}: field ${p}`);
    if (!f.fields.length && !f.about.length) problems.push(`${f.path} has no fields and no about lines`);
  }
  assert.deepEqual(problems, []);
});

// An object that has every key, each holding another such object.
const anything = (): object => new Proxy({}, { has: () => true, get: (_t, k) => (typeof k === 'string' ? anything() : undefined) });

test('the account-status line has a part for every field statusFromProfile and statusFromMe copy, both markers and every from value, and no other part', () => {
  const line = j.lines.find((l) => l.id === 'account-status');
  assert.ok(line, 'no entry for the account-status line');
  const parts = new Map(line.parts.map((p) => [p.path, p]));
  const copied = new Set([...Object.keys(statusFromProfile(anything()) ?? {}), ...Object.keys(statusFromMe(anything()) ?? {})]);
  assert.ok(copied.size >= 4, 'the copiers copied nothing from an answer that has every key');
  for (const k of copied) assert.ok(parts.has(k), `no part for ${k}`);
  const markers = ['not available', '(not reported)'];
  assert.ok(statusLine(null, 'me').includes(markers[0]) && statusLine({}, 'profile-after').includes(markers[1]), 'statusLine no longer prints the two markers');
  for (const m of markers) assert.ok(parts.has(m), `no part for ${m}`);
  const froms = new Set([{ after: anything() }, { before: anything() }, { me: anything() }, {}].map((b) => pickStatus(b).from));
  const from = parts.get('from');
  assert.ok(from, 'no part for from');
  for (const f of froms) assert.ok(from.meaning.includes(`\`${f}\``), `the from part doesn't name ${f}`);
  const known = new Set([...copied, ...markers, 'from']);
  assert.deepEqual([...parts.keys()].filter((p) => !known.has(p)), [], 'parts the code does not produce');
});

test('the Privacy: line has an entry with a part for both outcomes, and its method part names each method makeOwnerOnly reports', () => {
  const line = j.lines.find((l) => l.title.includes('Privacy:'));
  assert.ok(line, 'no entry for the Privacy: line');
  const m = /log\(`Privacy: \$\{owner\.ok \? '([^']+)' : '([^']+)'\}/.exec(read('src/export.ts'));
  assert.ok(m, 'src/export.ts no longer prints the Privacy: line this test reads');
  const parts = new Map(line.parts.map((p) => [p.path, p]));
  for (const outcome of [m[1], m[2]]) assert.ok(parts.has(outcome), `no part for ${outcome}`);
  const methods = /method: ('[\w-]+'(?: \| '[\w-]+')+);/.exec(read('src/permissions.ts'))?.[1].match(/[\w-]+/g) ?? [];
  assert.ok(methods.length >= 2, 'src/permissions.ts no longer lists the methods this test reads');
  for (const meth of methods) assert.ok(parts.get('method')?.meaning.includes(`\`${meth}\``), `the method part doesn't name ${meth}`);
});

// The keys a function reads from an answer's result, recorded by a stand-in result that has every key.
function readKeys(call: (body: unknown) => unknown): string[] {
  const keys = new Set<string>();
  const note = (k: string | symbol) => typeof k === 'string' && keys.add(k);
  const result = new Proxy({}, { has: (_t, k) => (note(k), true), get: (_t, k) => (note(k), undefined) });
  call({ result });
  return [...keys];
}

test('D19 and D20 have a result field for every key recordCounts and stayedCount read', () => {
  const page = (id: string) => j.files.find((f) => f.datasets.includes(id) && /^raw\/client\/[^/]+\/page-/.test(f.path));
  const checks: [string, string[]][] = [
    ['D19', readKeys((b) => recordCounts(b))],
    ['D20', readKeys((b) => stayedCount([b]))],
  ];
  for (const [id, keys] of checks) {
    const e = page(id);
    assert.ok(e, `${id} has no raw page entry`);
    assert.ok(keys.length > 0, `nothing read for ${id}`);
    const have = new Set(e.fields.map((f) => f.path));
    for (const k of keys) assert.ok(have.has(`result.${k}`), `${e.path} has no field result.${k}`);
  }
});

// Declarations anywhere in a file, nested ones included: function, async function, const, let, var,
// class, interface and type. Comments are dropped first.
const esc = (s: string) => s.replace(/[$]/g, '\\$');
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const declares = (src: string, name: string) => new RegExp(`(?:^|[^\\w$.])(?:(?:async\\s+)?function\\*?|const|let|var|class|interface|type)\\s+${esc(name)}(?![\\w$])`, 'm').test(src);
function classBody(src: string, cls: string): string | undefined {
  const m = new RegExp(`(?:^|[^\\w$.])class\\s+${esc(cls)}(?![\\w$])[^{]*\\{`).exec(src);
  if (!m) return undefined;
  let depth = 1;
  let i = m.index + m[0].length;
  for (; i < src.length && depth; i++) depth += src[i] === '{' ? 1 : src[i] === '}' ? -1 : 0;
  return src.slice(m.index + m[0].length, i - 1);
}
const hasMethod = (body: string, name: string) =>
  new RegExp(`^\\s*(?:(?:public|private|protected|static|async|readonly|override|get|set)\\s+)*\\*?\\s*${esc(name)}\\s*(?:<[^>]*>)?\\s*(?:\\(|=)`, 'm').test(body);

function citations(v: unknown, key = '', out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) key === 'sources' && typeof x === 'string' ? out.push(x) : citations(x, '', out);
  else for (const [k, x] of Object.entries(asObj(v) ?? {})) citations(x, k, out);
  return out;
}

test('every src/ citation names a file that exists, and any symbol it names is declared there (Class.method: the class has the method)', () => {
  const cites = [...new Set(citations(j).filter((s) => s.startsWith('src/')))];
  assert.ok(cites.length > 0, 'no src/ citations found');
  const problems: string[] = [];
  for (const c of cites) {
    const [file, sym, extra] = c.split('#');
    if (extra !== undefined || !/^src\/[\w./-]+\.ts$/.test(file)) {
      problems.push(`${c}: not a src/ file citation`);
      continue;
    }
    if (!fs.existsSync(path.join(ROOT, file))) {
      problems.push(`${c}: no such file`);
      continue;
    }
    if (sym === undefined) continue;
    const src = code(file);
    const [cls, method, more] = sym.split('.');
    if (more !== undefined) problems.push(`${c}: too many parts`);
    else if (method === undefined) {
      if (!declares(src, cls)) problems.push(`${c}: ${cls} is not declared in ${file}`);
    } else {
      const body = classBody(src, cls);
      if (body === undefined) problems.push(`${c}: no class ${cls} in ${file}`);
      else if (!hasMethod(body, method)) problems.push(`${c}: class ${cls} has no method ${method}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every field, part and about line has a known basis; inferred and unknown ones have a from, docs ones a from and a link', () => {
  const problems: string[] = [];
  for (const [where, b] of based()) {
    if (!['code', 'app', 'inferred', 'docs', 'unknown'].includes(b.basis)) problems.push(`${where}: basis ${b.basis}`);
    if (['inferred', 'unknown', 'docs'].includes(b.basis) && !b.from?.trim()) problems.push(`${where}: no from`);
    if (b.basis === 'docs' && !(b.sources ?? []).some(isUrl)) problems.push(`${where}: no link`);
  }
  assert.deepEqual(problems, []);
});

test('the text is plain: no <, >, [, ], * or | outside backticks, except a * path segment', () => {
  const bad = texts()
    .map(([where, s]): [string, string] => [where, s.replace(/`[^`]*`/g, '').replace(/(?<=[/.])\*(?=$|[\s/.,;:)])/g, '')])
    .filter(([, s]) => /[<>[\]*|]/.test(s))
    .map(([where, s]) => `${where}: ${/.{0,20}[<>[\]*|].{0,20}/.exec(s)?.[0]}`);
  assert.deepEqual(bad, []);
});

test('no export values or private notes: no 0x and 8 hex digits, no run of 5 or more digits (Ed25519 aside), no fieldmap, STATUS.md or handoff', () => {
  const bad = texts()
    .filter(([, s]) => /0x[0-9a-f]{8}/i.test(s) || /\d{5,}/.test(s.replace(/\bEd25519\b/g, '')) || /fieldmap|STATUS\.md|handoff/i.test(s))
    .map(([where]) => where);
  assert.deepEqual(bad, []);
});

// GitHub's heading anchors, computed here rather than by the generator: lower case, punctuation other
// than - and _ dropped, spaces to hyphens, and -1, -2 and so on for repeats.
function anchors(md: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fence = false;
  for (const l of md.split('\n')) {
    if (/^\s*```/.test(l)) fence = !fence;
    const m = fence ? null : /^#{1,6} (.+?)\s*#*\s*$/.exec(l);
    if (!m) continue;
    const base = m[1].toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

test('every link to FIELDS.md in README, USAGE and SPEC names a file that exists and, after #, a heading in FIELDS.md', () => {
  const problems: string[] = [];
  for (const rel of ['README.md', 'docs/USAGE.md', 'docs/SPEC.md']) {
    const links = [...read(rel).matchAll(/\]\(([^)\s]*FIELDS\.md(?:#[^)\s]*)?)\)/g)].map((m) => m[1]);
    if (!links.length) problems.push(`${rel}: no link to FIELDS.md`);
    for (const link of links) {
      const [target, anchor] = link.split('#');
      const file = path.resolve(path.dirname(path.join(ROOT, rel)), target);
      if (!fs.existsSync(file)) {
        problems.push(`${rel}: ${link} names no file`);
        continue;
      }
      if (anchor !== undefined && !anchors(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).has(anchor)) problems.push(`${rel}: ${link} names no heading`);
    }
  }
  assert.deepEqual(problems, []);
});
