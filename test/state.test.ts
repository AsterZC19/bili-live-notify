import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, resetDebounce } from '../src/state.js';
import { sessionText } from '../src/format.js';
import { snap, T } from './helpers.js';

test('initial live creates a historical session without a notification', () => {
  const r = advance(null, snap(0));
  assert.equal(r.events.length, 0);
  assert.equal(r.sessions[0]?.joinedLate, true);
  assert.equal(r.sessions[0]?.startSource, 'api');
});
test('offline to live emits a start event immediately, duplicate polls do not', () => {
  const baseline = advance(null, snap(-10_000, { live: false }));
  const start = advance(baseline.state, snap(0));
  assert.equal(start.events[0]?.kind, 'start');
  assert.equal(advance(start.state, snap(10_000)).events.length, 0);
});
test('confirmed offline backdates end time and duration, does not count debounce', () => {
  let r = advance(null, snap(0));
  r = advance(r.state, snap(10_000, { live: false }));
  r = advance(r.state, snap(20_000, { live: false }));
  r = advance(r.state, snap(30_000, { live: false }));
  assert.equal(r.events.length, 0);
  r = advance(r.state, snap(40_000, { live: false }));
  assert.equal(r.events[0]?.kind, 'end');
  assert.equal(r.sessions[0]?.endedAt, T + 10_000);
  assert.equal(r.sessions[0]?.durationSeconds, 10);
  assert.equal(advance(r.state, snap(50_000, { live: false })).events.length, 0);
});
test('short interruption merges even if upstream resets start time', () => {
  let r = advance(null, snap(0));
  const id = r.state.session!.id;
  r = advance(r.state, snap(10_000, { live: false }));
  r = advance(r.state, snap(20_000, { startedAt: T + 20_000 }));
  assert.equal(r.state.session!.id, id);
  assert.equal(r.events.length, 0);
  r = advance(r.state, snap(30_000, { startedAt: T + 20_000 }));
  assert.equal(r.state.session!.startedAt, T);
  assert.equal(r.events.length, 0);
});
test('titles must be stable for 20 seconds and A→B→A produces two changes', () => {
  let r = advance(null, snap(0));
  r = advance(r.state, snap(10_000, { title: 'B' }));
  r = advance(r.state, snap(20_000, { title: 'C' }));
  r = advance(r.state, snap(30_000, { title: 'B' }));
  r = advance(r.state, snap(40_000, { title: 'B' }));
  assert.equal(r.events.length, 0);
  r = advance(r.state, snap(50_000, { title: 'B' }));
  assert.equal(r.events[0]?.newTitle, 'B');
  r = advance(r.state, snap(60_000));
  r = advance(r.state, snap(70_000));
  r = advance(r.state, snap(80_000));
  assert.equal(r.events[0]?.oldTitle, 'B');
  assert.equal(r.events[0]?.newTitle, '标题 A');
});
test('pending offline suppresses title events', () => {
  let r = advance(null, snap(0));
  r = advance(r.state, snap(10_000, { title: 'B' }));
  r = advance(r.state, snap(20_000, { live: false, title: 'B' }));
  assert.equal(r.state.titleCandidate, null);
  assert.equal(r.events.length, 0);
});
test('a gap before offline leaves end and duration unknown', () => {
  let r = advance(null, snap(0));
  for (const offset of [60_000, 70_000, 80_000, 90_000]) r = advance(r.state, snap(offset, { live: false }));
  assert.equal(r.sessions[0]?.status, 'incomplete');
  assert.equal(r.sessions[0]?.endedAt, null);
  assert.equal(r.sessions[0]?.durationSeconds, null);
  assert.equal(r.sessions[0]?.lastLiveAt, T);
  assert.equal(r.sessions[0]?.firstOfflineAt, T + 60_000);
});
test('a new upstream start time closes an unobserved old session as incomplete', () => {
  const old = advance(null, snap(0));
  const next = advance(old.state, snap(60_000, { startedAt: T + 50_000 }));
  assert.equal(next.sessions.length, 2);
  assert.equal(next.sessions[0]?.status, 'incomplete');
  assert.equal(next.sessions[0]?.endedAt, null);
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0]?.kind, 'start');
});
test('unknown start uses observation and can later recover API time without splitting', () => {
  const first = advance(null, snap(20_000, { startedAt: null }));
  const next = advance(first.state, snap(30_000));
  assert.equal(first.state.session!.startSource, 'observed');
  assert.equal(next.state.session!.id, first.state.session!.id);
  assert.equal(next.state.session!.startedAt, T);
  assert.equal(next.events.length, 0);
});
test('restart clears debounce and stale concurrent responses cannot move state backwards', () => {
  let r = advance(null, snap(0));
  r = advance(r.state, snap(10_000, { title: 'B' }));
  assert.equal(resetDebounce(r.state).titleCandidate, null);
  assert.deepEqual(advance(r.state, snap(0)).state, r.state);
});
test('duration spans midnight; unknown values stay explicit in history', () => {
  let r = advance(null, snap(0, { startedAt: T - 25 * 3600_000 }));
  for (const offset of [10_000, 20_000, 30_000, 40_000]) r = advance(r.state, snap(offset, { live: false }));
  assert.equal(r.sessions[0]?.durationSeconds, 25 * 3600 + 10);
  assert.match(sessionText(r.sessions[0]!, 'Asia/Shanghai'), /25小时0分10秒/);
});
test('slower configured polling is not mistaken for an interrupted monitor', () => {
  let r = advance(null, snap(0), 180_000);
  r = advance(r.state, snap(60_000, { live: false }), 180_000);
  r = advance(r.state, snap(120_000, { live: false }), 180_000);
  assert.equal(r.sessions[0]?.endedAt, T + 60_000);
  assert.equal(r.sessions[0]?.durationSeconds, 60);
});
test('stale upstream start time cannot make a new session overlap a confirmed end', () => {
  let r = advance(null, snap(0));
  for (const n of [10_000, 20_000, 30_000, 40_000]) r = advance(r.state, snap(n, { live: false }));
  r = advance(r.state, snap(50_000));
  assert.equal(r.state.session!.startSource, 'observed');
  assert.equal(r.state.session!.startedAt, T + 50_000);
  r = advance(r.state, snap(60_000));
  assert.equal(r.state.session!.startedAt, T + 50_000);
});
