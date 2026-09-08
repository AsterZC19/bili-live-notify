import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Service, type Source } from '../src/service.js';
import { imageUrl, parseSnapshot, parseSource, startTime } from '../src/bilibili.js';
import { config } from '../src/config.js';
import { telegramCommand } from '../src/telegram.js';
import { discordAllowed, discordBody } from '../src/discord.js';
import { RemoteError } from '../src/model.js';
import { mediaFallback } from '../src/util.js';
import { snap, T } from './helpers.js';

test('source parsing distinguishes UID, long/short room IDs and rejects arbitrary URLs', () => {
  assert.deepEqual(parseSource('6'), { type: 'room', id: '6' });
  assert.deepEqual(parseSource('uid:123'), { type: 'uid', id: '123' });
  assert.deepEqual(parseSource('https://space.bilibili.com/123?x=1'), { type: 'uid', id: '123' });
  assert.deepEqual(parseSource('https://live.bilibili.com/456/'), { type: 'room', id: '456' });
  for (const input of ['0', '-1', 'https://evil.test/1', 'https://live.bilibili.com.evil.test/1', 'abc', 'javascript:123']) assert.throws(() => parseSource(input));
});
test('snapshots distinguish replay from live, validate missing fields and image domains', () => {
  const raw = { uid: 100, room_id: 200, uname: 'test', title: 'title', live_status: 2, live_time: 0 };
  assert.equal(parseSnapshot('100', raw, T)?.live, false);
  assert.equal(parseSnapshot('100', { ...raw, live_status: null }, T), null);
  assert.equal(parseSnapshot('100', { ...raw, live_status: 4 }, T), null);
  assert.equal(parseSnapshot('100', { ...raw, room_id: 0 }, T), null);
  assert.equal(parseSnapshot('100', { ...raw, uname: null }, T), null);
  assert.equal(imageUrl('http://i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg');
  assert.equal(imageUrl('https://hdslb.com.evil.test/a.jpg'), null);
  assert.equal(startTime(-62170012800, T), null);
  assert.equal(startTime(T / 1000 + 3600, T), null);
  assert.equal(startTime(T / 1000, T), T);
});
test('frame command uses a recent snapshot and never substitutes a cover', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const target = { platform: 'telegram' as const, id: '1' };
  const s = snap(0, { observedAt: Date.now() });
  store.subscribe(target, s);
  let calls = 0;
  const source: Source = {
    async resolve() { calls++; return s; },
    async statuses() { return new Map(); },
  };
  const service = new Service(store, 'Asia/Shanghai', source);
  assert.equal((await service.command(target, 'frame', '200'))[0]?.image, s.keyframe);
  assert.equal(calls, 0);
  store.db.prepare('UPDATE rooms SET state=? WHERE uid=?').run(JSON.stringify({ ...store.state('100'), snapshot: { ...s, keyframe: null } }), '100');
  const empty = (await service.command(target, 'frame', '200'))[0]!;
  assert.equal(empty.image, undefined); assert.match(empty.text, /暂未提供/);
});
test('stale frame data is refreshed and a now-offline room produces no image', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const target = { platform: 'telegram' as const, id: '1' };
  store.subscribe(target, snap(0, { observedAt: Date.now() - 20_000 }));
  const service = new Service(store, 'Asia/Shanghai', {
    async resolve() { return snap(0, { observedAt: Date.now(), live: false }); },
    async statuses() { return new Map(); },
  });
  const reply = (await service.command(target, 'frame', '200'))[0]!;
  assert.equal(reply.image, undefined); assert.match(reply.text, /当前未直播/);
});
test('poll batches shared subscriptions and missing status never becomes offline', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.subscribe({ platform: 'telegram', id: '1' }, snap(0));
  store.subscribe({ platform: 'discord', id: '2' }, snap(0));
  const service = new Service(store, 'Asia/Shanghai', {
    async resolve() { return snap(0); },
    async statuses(uids) { assert.deepEqual(uids, ['100']); return new Map(); },
  });
  await assert.rejects(service.poll(T + 60_000), /状态缺失/);
  assert.equal(store.state('100')!.live, true);
  assert.equal(store.history('100', 1)[0]?.endedAt, null);
});
test('50 monitored streamers use one batch and emit at most one event each', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const target = { platform: 'telegram' as const, id: '1' };
  for (let i = 1; i <= 50; i++) store.subscribe(target, snap(0, { uid: String(i), roomId: String(i + 100), live: false }));
  assert.throws(() => store.subscribe(target, snap(0, { uid: '51' })), /50/);
  let calls = 0;
  const service = new Service(store, 'Asia/Shanghai', {
    async resolve() { return snap(0); },
    async statuses(uids, now) {
      calls++; assert.equal(uids.length, 50);
      return new Map(uids.map(uid => [uid, snap(10_000, { uid, roomId: String(Number(uid) + 100), observedAt: now! })]));
    },
  });
  const start = performance.now(); const cpu = process.cpuUsage();
  await service.poll(T + 10_000); await service.poll(T + 20_000);
  assert.equal(calls, 2);
  assert.equal((store.db.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n, 50);
  t.diagnostic(JSON.stringify({ simulatedRooms: 50, twoPollsMs: performance.now() - start,
    rssMiB: process.memoryUsage().rss / 1024 / 1024, cpuMicros: process.cpuUsage(cpu) }));
});
test('Telegram accepts only the configured private sender, Discord only the owner guild text channel', () => {
  const update = { update_id: 1, message: { from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/history uid:100 2' } };
  assert.equal(telegramCommand(update, '123')?.page, 2);
  assert.equal(telegramCommand(update, '456'), null);
  assert.equal(telegramCommand({ ...update, message: { ...update.message, chat: { id: 123, type: 'group' } } }, '123'), null);
  assert.equal(discordAllowed('1', '2', 0, { owner: '1', guild: '2' }), true);
  assert.equal(discordAllowed('3', '2', 0, { owner: '1', guild: '2' }), false);
  assert.equal(discordAllowed('1', '2', 11, { owner: '1', guild: '2' }), false);
  assert.deepEqual(discordBody({ text: '@everyone **title**' }).allowed_mentions.parse, []);
});
test('image fallback occurs only on a definitive media error, never on an ambiguous timeout', async () => {
  const tried: (string | undefined)[] = [];
  await mediaFallback({ text: 'message', image: 'frame', fallbackImage: 'cover' }, async m => {
    tried.push(m.image); if (m.image) throw new RemoteError('bad image', undefined, true, true);
  });
  assert.deepEqual(tried, ['frame', 'cover', undefined]);
  let calls = 0;
  await assert.rejects(mediaFallback({ text: 'message', image: 'frame' }, async () => {
    calls++; throw new RemoteError('timeout');
  }));
  assert.equal(calls, 1);
});
test('configuration permits either bot alone and rejects partial or invalid settings', () => {
  const tg = { TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_OWNER_ID: '123' };
  assert.equal(config(tg).pollMs, 10_000);
  assert.throws(() => config({ TELEGRAM_BOT_TOKEN: 'test' }), /完整配置/);
  assert.throws(() => config({ ...tg, POLL_INTERVAL_SECONDS: '0' }));
  assert.throws(() => config({ ...tg, TZ: 'not-a-timezone' }));
  assert.throws(() => config({ ...tg, HEALTH_PORT: '99999' }));
});
test('history remains queryable offline after unsubscribe and is paginated', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const target = { platform: 'telegram' as const, id: '1' };
  store.subscribe(target, snap(0));
  const session = store.history('100', 1)[0]!;
  for (let n = 1; n <= 11; n++) store.saveSession({ ...session, id: `session-${n}`, startedAt: T + n });
  store.unsubscribe(target, '100');
  const service = new Service(store, 'Asia/Shanghai', {
    async resolve() { throw new Error('offline'); }, async statuses() { return new Map(); },
  });
  assert.equal((await service.command(target, 'history', '200', 1)).length, 10);
  assert.equal((await service.command(target, 'history', '200', 2)).length, 2);
  assert.match((await service.command(target, 'history', '200', -1))[0]!.text, /页码/);
});
