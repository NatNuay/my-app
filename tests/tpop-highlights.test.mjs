import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { normalizeLine, matchLyrics, detectChorus, trackNameVariants } from '../lib/highlight-analysis.ts';

const source = ts.transpileModule(fs.readFileSync(new URL('../lib/highlight-sources.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2017 },
}).outputText.replace('"./highlight-analysis"', JSON.stringify(new URL('../lib/highlight-analysis.ts', import.meta.url).href));
const { lyricQueries, inferLyricOffset, chapterHighlights, isChorusLabel } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const pattern = ['เธอคือคนเดียวที่ฉันต้องการ', 'ไม่ว่าจะนานเท่าไรฉันก็ยังรอ', 'ทุกวันมีแต่คำว่ารักเธอ', 'เก็บเธอไว้ในหัวใจตลอดไป'];
const lines = [20, 70, 120].flatMap((start, round) => [
  ...pattern.map((text, i) => ({ t: start + i * 4, text: round === 1 ? text.slice(0, 8) + ' ' + text.slice(8) : round === 2 ? text.slice(0, 8) + '\u200b' + text.slice(8) : text })),
  { t: start + 16, text: `เนื้อร้องที่ต่างกันในแต่ละรอบ ${round}` },
]);
const syncedLyrics = lines.map(({ t, text }) => `[${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}]${text}`).join('\n');

test('Thai spaces and zero-width formatting do not split repeated choruses', () => {
  assert.equal(normalizeLine('คิดถึง เธอ\u200bทุกวัน'), normalizeLine('คิดถึงเธอทุกวัน'));
  assert.equal(normalizeLine('hold me now'), 'hold me now');
  assert.deepEqual(detectChorus(lines), [{ start: 20, end: 36 }, { start: 70, end: 86 }, { start: 120, end: 136 }]);
});

test('Thai song queries survive aliases and sponsor text, without per-artist rules', () => {
  const queries = lyricQueries('ExampleBand - เกินต้าน (Too Cute) Dance Practice | By Sponsor', 'ExampleBand เกินต้าน By Sponsor');
  assert.ok(queries.includes('เกินต้าน')); assert.ok(queries.includes('Too Cute')); assert.ok(queries.length <= 6);
  assert.ok(lyricQueries('[DANCE PRACTICE] ฉ่ำ (CHARM) - ExampleBand', 'ฉ่ำ ExampleBand').includes('ฉ่ำ'));
  assert.ok(lyricQueries('ExampleBand - เพลงใหม่ (Forever)', 'ExampleBand เพลงใหม่').includes('Forever'));
  assert.ok(lyricQueries('ExampleBand : Vroom Vroom | Mirrored Dance Practice', 'ExampleBand Vroom Vroom').includes('Vroom Vroom'));
});

test('English aliases match bilingual Thai track records while retaining artist checks', () => {
  const rec = { trackName: 'เพลงใหม่ (New Song)', artistName: 'ExampleBand', duration: 180, syncedLyrics };
  assert.equal(matchLyrics([rec], 'ExampleBand - New Song Dance Practice', '', 180).status, 'ok');
  assert.equal(matchLyrics([rec], 'OtherBand - New Song Dance Practice', '', 180).status, 'none');
  assert.ok(!trackNameVariants('เพลงใหม่ (NINEW Version)', 'ExampleBand').includes('ninew version'));
});

test('long timestamped Thai lyric quotes can align without English-style word spaces', () => {
  const lyrics = [{ t: 30, text: pattern[0] }, { t: 90, text: pattern[1] }];
  assert.equal(inferLyricOffset(lyrics, [`0:37 ชอบท่อน${pattern[0]}มาก`, `1:37 ${pattern[1]}ที่สุด`], 200), 7);
  assert.equal(inferLyricOffset(lyrics, ['0:37 เต้นเก่งมาก', '1:37 เสื้อสวยมาก'], 200), undefined);
});

test('Thai hook spellings work and pre-hook labels are excluded', () => {
  for (const label of ['ฮุค', 'ฮุก', 'ท่อนสร้อย']) assert.equal(isChorusLabel(label), true);
  for (const label of ['ก่อนฮุก', 'ก่อนท่อนฮุค', 'หลังฮุก', 'พรีฮุก']) assert.equal(isChorusLabel(label), false);
  const segments = chapterHighlights('0:00 เริ่มเพลง\nฮุก0:40\nท่อนแร็ป1:00', [], 160);
  assert.equal(segments.length, 1); assert.equal(segments[0].start, 40); assert.equal(segments[0].end, 60);
});

test('plain Thai lyrics are distinguished from missing timed data without guessing boundaries', () => {
  const rec = { trackName: 'เพลงใหม่', artistName: 'ExampleBand', duration: 180, syncedLyrics: null, plainLyrics: pattern.join('\n') };
  assert.equal(matchLyrics([rec], 'ExampleBand เพลงใหม่ Dance Practice', '', 180).status, 'untimed');
  assert.equal(matchLyrics([rec], 'OtherBand เพลงใหม่ Dance Practice', '', 180).status, 'none');
});
