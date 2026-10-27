import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHighlightTime, readHighlightEdits } from '../lib/highlight-edits.ts';

test('manual boundaries accept seconds and clock times, reject malformed input', () => {
  for (const [text, seconds] of [['1:02', 62], ['62.5', 62.5], ['1:02:03', 3723], ['0:00', 0]]) assert.equal(parseHighlightTime(text), seconds);
  for (const text of ['', '-1', 'Infinity', '1:99', '1:60:00', 'abc', '1:2']) assert.equal(parseHighlightTime(text), undefined);
});

test('saved clip-specific edits round-trip; missing and explicitly empty lists stay distinct', () => {
  const raw = JSON.stringify([{ start: 62, end: 82, label: 'Full hook' }]);
  const result = readHighlightEdits(raw);
  assert.equal(result[0].start, 62); assert.equal(result[0].end, 82);
  assert.equal(readHighlightEdits(null), undefined);
  assert.deepEqual(readHighlightEdits('[]'), []);
  assert.equal(readHighlightEdits('{broken'), undefined);
  assert.equal(readHighlightEdits('[{"start":80,"end":20,"label":"Bad"}]'), undefined);
  assert.equal(readHighlightEdits('[{"start":-1,"end":20,"label":"Bad"}]'), undefined);
});
