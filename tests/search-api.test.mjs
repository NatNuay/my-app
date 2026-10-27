import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { NextRequest } from 'next/server.js';

let code = ts.transpileModule(fs.readFileSync(new URL('../app/api/youtube/search/route.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2017 },
}).outputText;
code = code.replaceAll('"next/server"', JSON.stringify(new URL('../node_modules/next/server.js', import.meta.url).href))
  .replaceAll('"@/lib/search-category"', JSON.stringify(new URL('../lib/search-category.ts', import.meta.url).href));
const { GET } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const originalFetch = globalThis.fetch, originalKey = process.env.YOUTUBE_API_KEY;
process.env.YOUTUBE_API_KEY = 'test-placeholder';
after(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = originalKey; });
const videos = [
  ['practice001', "Artist 'Song' Dance Practice"],
  ['mirrored001', "Artist 'Song' Dance Practice [MIRRORED]"],
  ['tutorial001', 'Song Dance Tutorial | Choreography (Slow + Mirror)'],
  ['steps000001', 'Step by Step Song #dancetutorial'],
  ['workout0001', 'Learn Kpop n SWEAT Song Kpop Workout'],
  ['music000001', 'Song Official MV'],
];
const respond = (data, status = 200) => new Response(JSON.stringify(data), { status });
function mock(detailsFail = false) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url); calls.push(u);
    if (u.pathname.endsWith('/search')) return respond({ items: videos.map(([id, title]) => ({ id: { videoId: id }, snippet: { title, channelTitle: 'Artist', thumbnails: {} } })) });
    if (detailsFail) return respond({ error: { message: 'quota exceeded' } }, 403);
    return respond({ items: videos.map(([id, title]) => ({ id, snippet: { title, tags: [], description: '' }, contentDetails: { duration: 'PT3M20S' }, status: { embeddable: true } })) });
  };
  return calls;
}
const request = (mode) => GET(new NextRequest(`http://example.test/api/youtube/search?q=song&mode=${mode}`));
test('each filtered mode excludes videos from the other category and workouts', async () => {
  for (const [mode, expected] of [['follow', ['practice001', 'mirrored001']], ['tutorial', ['tutorial001', 'steps000001']]]) {
    const calls = mock(); const response = await request(mode); const data = await response.json();
    assert.equal(response.status, 200); assert.deepEqual(data.items.map((v) => v.id), expected);
    assert.equal(calls.length, 2); assert.equal(calls[0].searchParams.get('maxResults'), '50');
    assert.equal(calls[1].searchParams.get('part'), 'snippet,contentDetails,status');
  }
});
test('all retains mixed video categories', async () => {
  mock(); const data = await (await request('all')).json(); assert.equal(data.items.length, videos.length);
});
test('detail errors and invalid modes do not masquerade as empty successful results', async () => {
  mock(true); assert.equal((await request('tutorial')).status, 403);
  const calls = mock(); assert.equal((await request('invalid')).status, 400); assert.equal(calls.length, 0);
});
