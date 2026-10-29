import test from 'node:test';
import assert from 'node:assert/strict';
import { readWatchHistory, recordVisit, HISTORY_LIMIT } from '../lib/watch-history.ts';

const video = (n) => ({ id: `clip${String(n).padStart(7, '0')}`, title: `Clip ${n}`, channel: 'Artist', thumbnail: '', durationSec: 180 });

test('reopening a video moves it first, updates its details and never duplicates it', () => {
  let history = recordVisit([], video(1), 1000);
  history = recordVisit(history, video(2), 2000);
  history = recordVisit(history, { ...video(1), title: 'Updated title' }, 3000);
  assert.deepEqual(history.map((entry) => entry.video.id), [video(1).id, video(2).id]);
  assert.equal(history[0].openedAt, 3000); assert.equal(history[0].video.title, 'Updated title');
  assert.equal(readWatchHistory(JSON.stringify(history)).length, 2);
});

test('history retains only the 100 most recently opened distinct videos', () => {
  let history = [];
  for (let n = 1; n <= 120; n++) history = recordVisit(history, video(n), n * 1000);
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[0].video.id, video(120).id);
  assert.equal(history.at(-1).video.id, video(21).id);
});

test('malformed storage is safe and duplicate entries retain the newest metadata', () => {
  for (const raw of [null, '{broken', '{}', '[null,1,"bad"]']) assert.deepEqual(readWatchHistory(raw), []);
  const entries = readWatchHistory(JSON.stringify([
    { video: video(1), openedAt: 1000 },
    { video: { ...video(1), title: 'Latest', durationSec: -1 }, openedAt: 3000 },
    { video: video(2), openedAt: 'yesterday' },
    { video: { id: 'invalid', title: 'Bad' }, openedAt: 2000 },
    { video: video(3), openedAt: 1e99 },
  ]));
  assert.equal(entries.length, 1); assert.equal(entries[0].video.title, 'Latest');
  assert.equal(entries[0].video.durationSec, 0);
});
