import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyVideo } from '../lib/search-category.ts';

test('official and mirrored practices stay in follow, even with tutorial promotions in metadata', () => {
  for (const title of ["Hearts2Hearts 하츠투하츠 'RUDE!' Dance Practice", "Hearts2Hearts - 'RUDE!' Dance Practice [MIRRORED]", 'Any Song Dance Cover', 'เพลงใหม่ เต้นตาม']) {
    assert.equal(classifyVideo(title, ['dance tutorial'], 'Watch my tutorial at this link'), 'follow');
  }
});
test('instruction titles win over mirror, slow and choreography words', () => {
  for (const title of ["Step by Step Hearts2Hearts 'RUDE!' #dancetutorial", 'Dance Tutorial | Easy K-Pop Choreography for Beginners (Slow + Mirror)', 'สอนเต้น เพลงใหม่ mirrored', 'Dance breakdown', 'How to dance the chorus']) {
    assert.equal(classifyVideo(title), 'tutorial');
  }
});
test('workouts and unknown videos are not silently labelled follow or tutorial', () => {
  assert.equal(classifyVideo('Learn Kpop n SWEAT RUDE Kpop Workout by a 10-Year Kpop Dancer'), 'other');
  assert.equal(classifyVideo('RUDE Official MV'), 'other');
  assert.equal(classifyVideo('My daily vlog'), 'other');
});
test('metadata helps ambiguous titles without changing a clearly named video type', () => {
  assert.equal(classifyVideo('Any Song', ['dance tutorial']), 'tutorial');
  assert.equal(classifyVideo('Any Song', ['dance practice']), 'follow');
  assert.equal(classifyVideo('Any Song', [], 'This is a dance tutorial'), 'tutorial');
});
