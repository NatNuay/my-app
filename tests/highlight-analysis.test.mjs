import test from 'node:test';
import assert from 'node:assert/strict';
import { detectChorus, matchLyrics, buildChorusSegments, parseChapters } from '../lib/highlight-analysis.ts';

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

test('conflicting duration copies cannot win merely by matching the video length', () => {
  const copies = [163, 164, 163, 165, 209].map((duration) => ({ ...record, duration }));
  const match = matchLyrics(copies, "Hearts2Hearts 'RUDE!' Dance Practice", '', 213);
  assert.equal(match.status, 'alignment');
  assert.ok(match.record.duration <= 165);
});

test('timed lyrics beyond declared song length and malformed nearest copies are rejected', () => {
  const match = matchLyrics([{ ...record, duration: 2 }, { ...record, duration: 200, syncedLyrics: '[00:00]one line' }, record], "Hearts2Hearts 'RUDE!' Dance Practice", '', 200);
  assert.equal(match.status, 'ok');
  assert.equal(match.lines.length, lines.length);
});

test('a title hook inside repeated pre-chorus blocks keeps the full chorus, not the pre-chorus prefix', () => {
  const lyric = [];
  for (const base of [0, 80, 160]) {
    ['Waiting for the lights', 'Building up the feeling', 'Taking one more breath'].forEach((text, i) => lyric.push({ t: base + i * 6, text: base === 160 ? `${text} final bridge ${i}` : text }));
    ['Satellite take us higher', 'We can travel through the stars', 'Nothing brings us back down', 'Keep on dancing here tonight', 'Feel the rhythm in the sky', 'We will never say goodbye'].forEach((text, i) => lyric.push({ t: base + 18 + i * 5, text }));
    lyric.push({ t: base + 48, text: `Different verse ${base}` });
  }
  assert.deepEqual(detectChorus(lyric, 'Satellite'), [{ start: 18, end: 48 }, { start: 98, end: 128 }, { start: 178, end: 208 }]);
  assert.deepEqual(detectChorus(lyric, 'Example Artist - Satellite (Official Audio)', 'Example Artist'), [{ start: 18, end: 48 }, { start: 98, end: 128 }, { start: 178, end: 208 }]);
});

test('a complete 45-second repeated chorus is not cut at the former 40-second limit', () => {
  const lyric = [];
  for (const base of [0, 80]) {
    for (let i = 0; i < 9; i++) lyric.push({ t: base + i * 5, text: `The repeated chorus phrase number ${i}` });
    lyric.push({ t: base + 45, text: `Unique verse ${base}` });
  }
  assert.deepEqual(detectChorus(lyric), [{ start: 0, end: 45 }, { start: 80, end: 125 }]);
});

test('a title sung in the middle of a chorus does not cut off its beginning', () => {
  const lyric = [];
  for (const base of [0, 80]) {
    ['We fly through the night', 'Feel the stars all around us', 'Satellite take us higher', 'Never let this feeling go', 'Together we rise above', 'Carry the light back home'].forEach((text, i) => lyric.push({ t: base + i * 5, text }));
    lyric.push({ t: base + 30, text: `Unique verse ${base}` });
  }
  assert.deepEqual(detectChorus(lyric, 'Satellite'), [{ start: 0, end: 30 }, { start: 80, end: 110 }]);
});

test('a sustained title refrain separates a long repeated lead-in without a third chorus', () => {
  const lyric = [];
  for (const base of [0, 80]) {
    ['Raise the lights above us', 'Everybody feel the tension', 'Waiting for the moment'].forEach((text, i) => lyric.push({ t: base + i * 5, text }));
    ['Satellite take us higher', 'Feel the rhythm all around', 'Satellite keep us moving', 'Carry the light back home'].forEach((text, i) => lyric.push({ t: base + 15 + i * 5, text }));
    lyric.push({ t: base + 35, text: `Unique verse ${base}` });
  }
  assert.deepEqual(detectChorus(lyric, 'Satellite'), [{ start: 15, end: 35 }, { start: 95, end: 115 }]);
});

test('overlong repeated structures are rejected instead of returning an arbitrarily clipped prefix', () => {
  const lyric = [];
  for (const base of [0, 120]) {
    for (let i = 0; i < 20; i++) lyric.push({ t: base + i * 4, text: `Long repeated structure number ${i}` });
    lyric.push({ t: base + 80, text: `Unique verse ${base}` });
  }
  assert.deepEqual(detectChorus(lyric), []);
});

test('explicit ranges and label-first chapters retain their own end boundaries', () => {
  assert.deepEqual(parseChapters('Dance Break 1:59–2:34', 156).map(({ start, end, label }) => ({ start, end, label })), [{ start: 119, end: 154, label: 'Dance Break' }]);
  assert.deepEqual(parseChapters('Chorus 0:40\nBridge 1:02', 100).map(({ start, end }) => [start, end]), [[40, 62], [62, 100]]);
  assert.deepEqual(parseChapters('2:34-1:59 Dance Break', 156), []);
});
