import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// Compile the pure source module with the project's pinned TypeScript; no application server or network.
const source = ts.transpileModule(fs.readFileSync(new URL('../lib/highlight-sources.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2017 },
}).outputText.replace('"./highlight-analysis"', JSON.stringify(new URL('../lib/highlight-analysis.ts', import.meta.url).href));
const { chapterHighlights, inferChorusOffset, inferLyricOffset, lyricQueries, isChorusLabel } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('uploader chapters work without any song identity or lyric database', () => {
  const result = chapterHighlights('0:00 Intro\n0:20 Chorus 1\n0:42 Verse\n1:10 Chorus 2\n1:32 Outro', [], 100);
  assert.deepEqual(result.map(({ start, end }) => [start, end]), [[20, 42], [70, 92]]);
  assert.equal(result[0].confidence, 'high');
});

test('pre/post chorus and isolated timestamp comments are not complete hooks', () => {
  assert.equal(isChorusLabel('pre-chorus'), false);
  assert.equal(isChorusLabel('post chorus'), false);
  assert.equal(isChorusLabel('chorus tutorial'), false);
  assert.deepEqual(chapterHighlights('', [{ text: '1:02 chorus!', likes: 9999 }], 200), []);
  assert.deepEqual(chapterHighlights('0:00 Intro\n0:20 Chorus\n3:00 Outro', [], 200), []);
});

test('full comment section lists preserve each individual boundary and explain their source', () => {
  const result = chapterHighlights('', [{ text: '0:00 intro\n0:30 chorus 1\n0:50 verse\n1:20 chorus 2\n1:42 bridge', likes: 0 }], 130);
  assert.deepEqual(result.map(({ start, end }) => [start, end]), [[30, 50], [80, 102]]);
  assert.equal(result[0].confidence, 'medium');
  assert.match(result[0].evidence, /คอมเมนต์/);
});

test('multiple consistent hook anchors infer offset for any song, independently of clip duration', () => {
  assert.ok(Math.abs(inferChorusOffset([{ start: 30.2, end: 50 }, { start: 80.2, end: 100 }, { start: 140.2, end: 160 }], ['0:43 chorus 1\n1:33 chorus 2\n2:33 last chorus'], 240) - 12.8) < 0.001);
  assert.equal(inferChorusOffset([{ start: 30, end: 50 }, { start: 80, end: 100 }], ['0:43 chorus'], 240), undefined);
});

test('ambiguous or drifting hook times cannot silently align the song', () => {
  const occurrences = [{ start: 30, end: 50 }, { start: 80, end: 100 }];
  assert.equal(inferChorusOffset(occurrences, ['0:30 chorus\n1:20 chorus\n2:10 chorus'], 240), undefined);
  assert.equal(inferChorusOffset(occurrences, ['0:40 chorus\n1:40 chorus'], 240), undefined);
  assert.equal(inferChorusOffset(occurrences, ['0:43 best hair\n1:33 lovely face'], 240), undefined);
});

test('query fallbacks are bounded and retain quoted song titles for any artist', () => {
  assert.deepEqual(lyricQueries("Artist 아티스트 'Song!' Dance Practice", 'Artist 아티스트 Song!'), ['Artist 아티스트 Song!', 'Artist Song!', 'Song!']);
  assert.deepEqual(lyricQueries('Song', 'Song'), ['Song']);
});

test('timestamped lyric quotes can align intro/outro clips without changing audio input', () => {
  const lines = [{ t: 30, text: 'We are dancing through the night' }, { t: 90, text: 'Nothing can stop us now' }];
  assert.equal(inferLyricOffset(lines, ['0:37 "We are dancing through the night"', '1:37 Nothing can stop us now!'], 264), 7);
});

test('single quotes, duplicated comments and unrelated timestamp praise do not establish alignment', () => {
  const lines = [{ t: 30, text: 'We are dancing through the night' }, { t: 90, text: 'Nothing can stop us now' }];
  assert.equal(inferLyricOffset(lines, ['0:37 We are dancing through the night', '0:37 We are dancing through the night'], 264), undefined);
  assert.equal(inferLyricOffset(lines, ['0:37 nice clothes', '1:37 pretty faces'], 264), undefined);
  assert.equal(inferLyricOffset(lines, ['0:37 We are dancing through the night', '1:47 Nothing can stop us now'], 264), undefined);
});

test('dance breaks are independent of choruses and do not require two chorus chapters', () => {
  const result = chapterHighlights('0:00 Intro\n0:40 Chorus\n1:05 Verse\n1:59 Dance Break\n2:34 Outro', [], 156);
  assert.equal(result.find((s) => s.kind === 'dance-break').start, 119);
  assert.equal(result.find((s) => s.kind === 'dance-break').end, 154);
  assert.equal(result.find((s) => s.kind === 'chorus').start, 40);
});

test('an explicitly bounded dance-break comment can stand alone', () => {
  const result = chapterHighlights('', [{ text: 'เบรคแดนซ์ 2:40–3:05', likes: 0 }], 196);
  assert.equal(result.length, 1); assert.equal(result[0].kind, 'dance-break');
  assert.equal(result[0].start, 160); assert.equal(result[0].end, 185);
});

test('a popular timestamp or lyric gap alone is not labelled dance break', () => {
  assert.deepEqual(chapterHighlights('', [{ text: '2:40', likes: 100 }, { text: '2:40 nice move', likes: 10 }, { text: '2:40-3:05', likes: 20 }], 196), []);
  assert.deepEqual(chapterHighlights('', [{ text: '2:40 Dance Break', likes: 100 }], 196), []);
});

test('uploader chorus chapters can coexist with an independently bounded comment dance break', () => {
  const result = chapterHighlights('0:00 Intro\n0:40 Chorus\n1:05 Verse', [{ text: '1:59-2:34 Dance Break', likes: 0 }], 156);
  assert.deepEqual(result.map((s) => s.kind), ['chorus', 'dance-break']);
});

const references = JSON.parse(fs.readFileSync(new URL('./fixtures/highlight-reference-cases.json', import.meta.url), 'utf8'));
test('BAD reference comments recover the user-confirmed 1:59 start using the generic rule', () => {
  const ref = references.bad;
  const result = chapterHighlights('', ref.comments, ref.duration);
  const danceBreak = result.find((s) => s.kind === 'dance-break');
  assert.equal(danceBreak.start, ref.referenceStart);
  assert.equal(danceBreak.end, 154);
});

test('PSYCHO reference remains unresolved: generic timestamps cannot fabricate its known 2:40 break', () => {
  const ref = references.psycho;
  assert.equal(ref.referenceStart, 160);
  assert.deepEqual(chapterHighlights('', ref.comments, ref.duration), []);
});
