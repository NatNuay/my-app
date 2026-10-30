import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { NextRequest } from 'next/server.js';
import { audioChoruses, combineAudioHighlights, retainDisplayedHighlights, selectHighlightProposal } from '../lib/audio-highlights.ts';

test('audio chorus times include the original clip intro; instrumental labels are not dance breaks', () => {
  const segments = audioChoruses([
    { start: 0, end: 15, label: 'intro' },
    { start: 62, end: 90, label: 'chorus' },
    { start: 119, end: 154, label: 'break' },
    { start: 160, end: 180, label: 'inst' },
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].start, 62);
  assert.equal(segments[0].end, 90);
  assert.equal(segments[0].confidence, 'medium');
});

test('invalid, overlapping and out-of-budget model ranges are rejected', () => {
  assert.equal(audioChoruses(null).length, 0);
  const ranges = audioChoruses([
    { start: -1, end: 10, label: 'chorus' }, { start: 20, end: Infinity, label: 'chorus' },
    { start: '20', end: 40, label: 'chorus' }, { start: 5, end: 7, label: 'chorus' },
    { start: 890, end: 910, label: 'chorus' }, { start: 1, end: 150, label: 'chorus' },
    { start: 20, end: 40, label: 'chorus' }, { start: 30, end: 50, label: 'chorus' },
  ]);
  assert.equal(ranges.length, 1);
});

test('audio replaces lyric chorus but retains non-overlapping explicit dance break; failure retains metadata', () => {
  const audio = audioChoruses([{ start: 62, end: 90, label: 'chorus' }]);
  const metadata = [{ ...audio[0], start: 50, end: 75 },
    { ...audio[0], kind: 'dance-break', start: 119, end: 154 }];
  assert.deepEqual(combineAudioHighlights(metadata, []), metadata);
  assert.deepEqual(combineAudioHighlights(metadata, audio).map(s => s.start), [62, 119]);
});

let code = ts.transpileModule(fs.readFileSync(new URL('../app/api/youtube/audio-highlights/route.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2017 },
}).outputText;
code = code.replaceAll('"@/lib/audio-highlights"', JSON.stringify(new URL('../lib/audio-highlights.ts', import.meta.url).href))
  .replaceAll('"next/server"', JSON.stringify(new URL('../node_modules/next/server.js', import.meta.url).href));
const { GET } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const savedFetch = globalThis.fetch;
const savedUrl = process.env.AUDIO_ANALYSIS_URL;
const savedToken = process.env.AUDIO_ANALYSIS_TOKEN;
after(() => {
  globalThis.fetch = savedFetch;
  for (const [key, value] of [['AUDIO_ANALYSIS_URL', savedUrl], ['AUDIO_ANALYSIS_TOKEN', savedToken]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const request = (v = 'RXQCY_zxz-E') => GET(new NextRequest('http://localhost/api/youtube/audio-highlights?v=' + encodeURIComponent(v)));
test('optional worker is disabled cleanly and rejects arbitrary URLs as IDs', async () => {
  delete process.env.AUDIO_ANALYSIS_URL;
  globalThis.fetch = async () => { throw Error('must not fetch'); };
  assert.equal((await (await request()).json()).status, 'disabled');
  assert.equal((await request('https://example.org')).status, 400);
});
test('worker job status and filtered results are forwarded without exposing credentials', async () => {
  process.env.AUDIO_ANALYSIS_URL = 'http://127.0.0.1:8765';
  process.env.AUDIO_ANALYSIS_TOKEN = 'test-only';
  globalThis.fetch = async (url, options) => {
    assert.equal(url.href, 'http://127.0.0.1:8765/jobs/RXQCY_zxz-E');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    return Response.json({ status: 'ready', segments: [{ start: 62, end: 90, label: 'chorus' }, { start: 119, end: 154, label: 'break' }] });
  };
  const data = await (await request()).json();
  assert.equal(data.status, 'ready'); assert.equal(data.segments.length, 1);
  globalThis.fetch = async () => { throw Error('private connection details'); };
  assert.deepEqual(await (await request()).json(), { status: 'failed', segments: [] });
});
test('remote worker cannot send credentials over plain HTTP', async () => {
  process.env.AUDIO_ANALYSIS_URL = 'http://remote.example';
  globalThis.fetch = async () => { throw Error('must not fetch'); };
  assert.equal((await (await request()).json()).status, 'failed');
});

test('touching chorus predictions merge, separated rounds and verse gaps remain distinct', () => {
  const segments = audioChoruses([
    { start: 64, end: 80.9, label: 'chorus' },
    { start: 109, end: 124, label: 'chorus' },
    { start: 124, end: 138.1, label: 'chorus' },
    { start: 138.1, end: 169, label: 'bridge' },
    { start: 169, end: 199, label: 'chorus' },
  ]);
  assert.deepEqual(segments.map(s => [s.start, s.end]), [[64, 80.9], [109, 138.1], [169, 199]]);
});

test('fast candidates are clearly experimental and preserve explicit chapter choruses', () => {
  const candidates = audioChoruses([{ start: 32, end: 56, label: 'chorus' }], 'fast');
  assert.match(candidates[0].label, /ทดลอง/);
  assert.doesNotMatch(candidates[0].evidence, /All-In-One/);
  const chapters = [{ ...candidates[0], start: 30, end: 58, label: 'Uploader chorus' }];
  assert.deepEqual(combineAudioHighlights(chapters, candidates, true), chapters);
});
test('API passes fast engine provenance and labels to the browser', async () => {
  process.env.AUDIO_ANALYSIS_URL = 'http://127.0.0.1:8765';
  globalThis.fetch = async () => Response.json({ status: 'ready', engine: 'fast', segments: [{ start: 32, end: 56, label: 'chorus' }] });
  const data = await (await request()).json();
  assert.equal(data.engine, 'fast');
  assert.match(data.segments[0].label, /ทดลอง/);
});

test('late conflicting audio cannot replace or remove an already displayed lyric chorus set', () => {
  const first = audioChoruses([{ start: 30, end: 58, label: 'chorus' }, { start: 90, end: 118, label: 'chorus' }]);
  const late = audioChoruses([{ start: 42, end: 66, label: 'chorus' }], 'fast');
  assert.equal(retainDisplayedHighlights(first, late), first);
  assert.equal(retainDisplayedHighlights(first, []), first);
});
test('late metadata cannot silently replace the audio chorus set that was displayed first', () => {
  const first = audioChoruses([{ start: 32, end: 56, label: 'chorus' }], 'fast');
  const late = [{ ...first[0], start: 45, end: 70, label: 'Late uploader range' }];
  assert.equal(retainDisplayedHighlights(first, late), first);
});
test('empty or break-only first results still accept later choruses and distinct dance breaks', () => {
  const chorus = audioChoruses([{ start: 32, end: 56, label: 'chorus' }]);
  assert.equal(retainDisplayedHighlights([], chorus), chorus);
  const dance = { ...chorus[0], kind: 'dance-break', start: 120, end: 140 };
  assert.deepEqual(retainDisplayedHighlights([dance], chorus).map(s => s.start), [32, 120]);
  const overlap = { ...dance, start: 40, end: 65 };
  assert.deepEqual(retainDisplayedHighlights(chorus, [overlap, dance]).map(s => s.start), [32, 120]);
});

test('real reference lyric mid-hook/pre-hook guesses are deferred while fast audio is pending', () => {
  const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/fast-chorus-reference-cases.json', import.meta.url), 'utf8')).cases;
  for (const reference of cases) {
    const lyric = reference.legacyLyricsSegments.map(s => ({ ...s, kind: 'chorus', label: 'Lyrics', confidence: 'high', evidence: 'Captured API result' }));
    const pending = selectHighlightProposal(lyric, [], { pending: true, engine: 'fast', source: 'lyrics' });
    assert.deepEqual(pending, []);
    const audio = audioChoruses([{ ...reference.expectedOccurrence, label: 'chorus' }], 'fast');
    const ready = selectHighlightProposal(lyric, audio, { pending: false, engine: 'fast', source: 'lyrics' });
    const displayed = retainDisplayedHighlights(pending, ready);
    assert.deepEqual(displayed.map(s => [s.start, s.end]), [[reference.expectedOccurrence.start, reference.expectedOccurrence.end]]);
    assert.equal(retainDisplayedHighlights(displayed, lyric), displayed);
  }
});
test('explicit chapters need not wait; unavailable or empty audio still permits lyric fallback', () => {
  const lyric = audioChoruses([{ start: 30, end: 58, label: 'chorus' }]);
  assert.equal(selectHighlightProposal(lyric, [], { pending: true, engine: 'fast', source: 'chapters' }), lyric);
  assert.equal(selectHighlightProposal(lyric, [], { pending: false, source: 'lyrics' }), lyric);
  assert.equal(selectHighlightProposal(lyric, [], { pending: false, engine: 'fast', source: 'lyrics' }), lyric);
  const dance = [{ ...lyric[0], kind: 'dance-break', start: 120, end: 140 }];
  assert.deepEqual(selectHighlightProposal([...lyric, ...dance], [], { pending: true, engine: 'fast', source: 'mixed' }), dance);
});
