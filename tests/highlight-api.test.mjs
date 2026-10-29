import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { NextRequest } from 'next/server.js';

function compile(path, replacements) {
  let code = ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2017 },
  }).outputText;
  for (const [from, to] of Object.entries(replacements)) code = code.replaceAll(JSON.stringify(from), JSON.stringify(to));
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}
const analysis = new URL('../lib/highlight-analysis.ts', import.meta.url).href;
const sources = compile('../lib/highlight-sources.ts', { './highlight-analysis': analysis });
const route = compile('../app/api/youtube/highlights/route.ts', {
  '@/lib/highlight-analysis': analysis, '@/lib/highlight-sources': sources,
  'next/server': new URL('../node_modules/next/server.js', import.meta.url).href,
});
const { GET } = await import(route);
const originalFetch = globalThis.fetch;
const originalKey = process.env.YOUTUBE_API_KEY;
process.env.YOUTUBE_API_KEY = 'test-placeholder';
after(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = originalKey; });

const chapterText = '0:00 Intro\n0:20 Chorus 1\n0:42 Verse\n1:10 Chorus 2\n1:32 Outro';
const snippet = (description = '', title = "Some Artist 'New Song' Dance Practice", duration = 'PT3M20S') => ({ items: [{ snippet: { title, channelTitle: 'Some Artist', description, tags: [] }, contentDetails: { duration } }] });
const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const request = (query = 'v=anyClip0001') => GET(new NextRequest('http://example.test/api/youtube/highlights?' + query));
const pattern = ['Dance in your own way', 'RUDE!', 'Nothing can stop us now', 'We are moving together', 'Keep the music going', 'We will dance forever'];
const lyrics = [0, 60, 120].flatMap((start) => pattern.map((text, i) => `[${Math.floor((start + i * 3) / 60)}:${String((start + i * 3) % 60).padStart(2, '0')}]${text}`).concat(`[${Math.floor((start + 18) / 60)}:${String((start + 18) % 60).padStart(2, '0')}]unique verse ${start}`)).join('\n');
const record = { trackName: 'New Song', artistName: 'Some Artist', duration: 200, syncedLyrics: lyrics };

test('uploader hook chapters survive unavailable optional analysis sources', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return respond(snippet(chapterText, 'A concert recording')); };
  const response = await request(); const data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.source, 'chapters'); assert.equal(data.segments.length, 2); assert.ok(calls >= 1);
});

test('manual time offsets are no longer accepted', async () => {
  globalThis.fetch = async () => { throw Error('network must not be called'); };
  assert.equal((await request('v=anyClip0001&offset=2.5')).status, 400);
});

test('comment section lists work even if no lyric service is available', async () => {
  globalThis.fetch = async (url) => new URL(url).pathname.endsWith('/videos') ? respond(snippet()) :
    respond({ items: [{ snippet: { topLevelComment: { snippet: { textDisplay: chapterText, likeCount: 1 } } } }] });
  const data = await (await request()).json(); assert.equal(data.source, 'comments'); assert.equal(data.segments.length, 2);
});

test('disabled comments and comment network failures do not prevent lyric analysis', async () => {
  for (const networkFailure of [false, true]) {
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/videos')) return respond(snippet());
      if (u.pathname.endsWith('/commentThreads')) { if (networkFailure) throw Error('offline'); return respond({}, 403); }
      return respond([record]);
    };
    const data = await (await request()).json(); assert.equal(data.source, 'lyrics'); assert.equal(data.segments.length, 3);
  }
});

test('longer clips without alignment evidence have no highlights and cannot be manually overridden', async () => {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/videos')) return respond(snippet('', undefined, 'PT3M33S'));
    if (u.pathname.endsWith('/commentThreads')) return respond({}, 403);
    return respond([record]);
  };
  const data = await (await request()).json(); assert.equal(data.reason, 'alignment-required'); assert.deepEqual(data.segments, []);
  assert.equal((await request('v=anyClip0001&offset=13')).status, 400);
});

test('API quota and lyric outages remain errors, not fake successful no-result detections', async () => {
  globalThis.fetch = async () => respond({ error: { code: 403 } }, 403);
  assert.equal((await request()).status, 503);
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/videos')) return respond(snippet());
    return respond({}, 503);
  };
  assert.equal((await request()).status, 503);
});

test('invalid IDs and offsets are rejected before network work', async () => {
  globalThis.fetch = async () => { throw Error('network must not be called'); };
  for (const query of ['v=bad', 'v=anyClip0001&offset=Infinity', 'v=anyClip0001&offset=121', 'v=anyClip0001&offset=']) {
    assert.equal((await request(query)).status, 400);
  }
});


test('longer clips still align automatically with consistent chorus timestamps', async () => {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/videos')) return respond(snippet('', undefined, 'PT3M33S'));
    if (u.pathname.endsWith('/commentThreads')) return respond({ items: [{ snippet: { topLevelComment: { snippet: { textDisplay: '0:13 chorus 1\n1:13 chorus 2\n2:13 chorus 3', likeCount: 0 } } } }] });
    return respond([record]);
  };
  const data = await (await request()).json();
  assert.equal(data.segments.length, 3); assert.equal(data.appliedOffset, 13); assert.equal(data.segments[0].start, 13);
});

test('timestamped lyric quotes align longer clips without an audio import change', async () => {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/videos')) return respond(snippet('', undefined, 'PT3M33S'));
    if (u.pathname.endsWith('/commentThreads')) return respond({ items: [{ snippet: { topLevelComment: { snippet: { textDisplay: '0:13 Dance in your own way\n1:19 Nothing can stop us now\n2:31 unique verse 120', likeCount: 0 } } } }] });
    return respond([record]);
  };
  const data = await (await request()).json();
  assert.equal(data.segments.length, 3); assert.equal(data.appliedOffset, 13);
});

test('a bounded dance break does not replace the lyric chorus results', async () => {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/videos')) return respond(snippet());
    if (u.pathname.endsWith('/commentThreads')) return respond({ items: [{ snippet: { topLevelComment: { snippet: { textDisplay: '2:40-3:05 Dance Break', likeCount: 0 } } } }] });
    return respond([record]);
  };
  const data = await (await request()).json();
  assert.equal(data.source, 'mixed');
  assert.equal(data.segments.filter((s) => s.kind === 'chorus').length, 3);
  assert.equal(data.segments.filter((s) => s.kind === 'dance-break').length, 1);
  assert.equal(data.segments.find((s) => s.kind === 'dance-break').start, 160);
});

test('plain lyrics have an explicit no-timestamps outcome, not fabricated highlights', async () => {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/videos')) return respond(snippet());
    if (u.pathname.endsWith('/commentThreads')) return respond({}, 403);
    return respond([{ ...record, syncedLyrics: null, plainLyrics: 'เนื้อเพลงที่ไม่มีเวลาประกอบแต่ละบรรทัด' }]);
  };
  const response = await request(); const data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.reason, 'untimed-lyrics'); assert.deepEqual(data.segments, []);
});
