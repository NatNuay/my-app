import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// Compile the pure source module with the project's pinned TypeScript; no application server or network.
const source = ts.transpileModule(fs.readFileSync(new URL('../lib/highlight-sources.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2017 },
}).outputText.replace('"./highlight-analysis"', JSON.stringify(new URL('../lib/highlight-analysis.ts', import.meta.url).href));
const { chapterHighlights, inferChorusOffset, lyricQueries, isChorusLabel } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

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
