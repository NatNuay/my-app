import test from 'node:test';
import assert from 'node:assert/strict';
import { detectChorus, matchLyrics, buildChorusSegments } from '../lib/highlight-analysis.ts';

const pattern = ["RUDE!", "moving together in our own way", "I'm not bad", "You can't make me act right", "RUDE!", "dancing together with no rules", "따라 해", "You can't make me act right"];
const chorus = (start) => pattern.map((text, i) => ({ t: start + i * 2, text }));
const lines = [
  { t: 0, text: 'A unique opening verse' },
  { t: 28, text: "I've been acting too" }, ...chorus(30),
  { t: 46, text: 'A different second verse' },
  { t: 78, text: "I've been acting too" }, ...chorus(80),
  { t: 96, text: 'A unique bridge to the final chorus' },
  ...chorus(130), { t: 146, text: 'The song ends right here' },
];

test('short hook words do not split three choruses; pickup stays local to each occurrence', () => {
  assert.deepEqual(detectChorus(lines), [
    { start: 28, end: 46 }, { start: 78, end: 96 }, { start: 130, end: 146 },
  ]);
});

test('filler alone is not a chorus and unrelated verses do not create one', () => {
  assert.deepEqual(detectChorus(Array.from({ length: 20 }, (_, i) => ({ t: i * 3, text: 'oh oh' }))), []);
  assert.deepEqual(detectChorus(Array.from({ length: 20 }, (_, i) => ({ t: i * 3, text: `unique lyric line ${i}` }))), []);
});

const lrc = lines.map(({ t, text }) => `[${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}]${text}`).join('\n');
const record = { trackName: 'RUDE!', artistName: 'Hearts2Hearts', duration: 200, syncedLyrics: lrc };
test('same song with extra video time requires alignment, without silently assuming intro length', () => {
  assert.equal(matchLyrics([record], "Hearts2Hearts 'RUDE!' Dance Practice", '', 200).status, 'ok');
  assert.equal(matchLyrics([record], "Hearts2Hearts 하츠투하츠 'RUDE!' Dance Practice", '', 213).status, 'alignment');
  assert.equal(matchLyrics([record], "Other Artist 'RUDE!' Dance Practice", '', 213).status, 'none');
  assert.equal(matchLyrics([{ ...record, duration: NaN }], "Hearts2Hearts 'RUDE!'", '', 200).status, 'none');
});

test('segments clip to video bounds and retain chronological round labels', () => {
  const segments = buildChorusSegments([{ start: -2, end: 14 }, { start: 90, end: 110 }], [], [], 100);
  assert.deepEqual(segments.map(({ start, end }) => ({ start, end })), [{ start: 0, end: 14 }, { start: 90, end: 100 }]);
});
