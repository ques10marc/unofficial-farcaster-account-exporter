import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv, toCsv } from '../src/csv.ts';

test('CSV round-trips commas, quotes, newlines and edge whitespace', () => {
  const rows = [
    [1, 'plain', 'a,b', 'say "hi"'],
    [2, 'multi\nline', ' lead', ''],
    [3, undefined, null, 'trail '],
  ];
  const text = toCsv(['id', 'x', 'y', 'z'], rows);
  assert.ok(text.endsWith('\r\n'));
  const parsed = parseCsv(text);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed[1], ['1', 'plain', 'a,b', 'say "hi"']);
  assert.deepEqual(parsed[2], ['2', 'multi\nline', ' lead', '']);
  assert.deepEqual(parsed[3], ['3', '', '', 'trail ']);
});

test('header-only CSV has zero data rows', () => {
  assert.deepEqual(parseCsv(toCsv(['a', 'b'], [])), [['a', 'b']]);
});
