import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { advance } from '../src/state.js';
import { Deliverer } from '../src/delivery.js';
import { RemoteError, type Target } from '../src/model.js';
import { snap, T } from './helpers.js';
const tg: Target = { platform: 'telegram', id: '1' };
const dc: Target = { platform: 'discord', id: '2' };
test('independent subscriptions share monitoring and a single session', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  assert.equal(store.subscribe(tg, snap(0)), true);
  assert.equal(store.subscribe(tg, snap(0)), false);
  assert.equal(store.subscribe(dc, snap(0)), true);
  assert.equal(store.states().length, 1);
  assert.equal(store.history('100', 1).length, 1);
  assert.equal(store.unsubscribe(tg, '100'), true);
  assert.equal(store.states(tg).length, 0);
  assert.equal(store.states(dc).length, 1);
  store.commit(advance(store.state('100'), snap(10_000)), 'Asia/Shanghai');
  assert.equal(store.history('100', 1).length, 1);
});
test('last unsubscribe retains incomplete history and cancels pending deliveries', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.subscribe(tg, snap(-10_000, { live: false }));
  store.commit(advance(store.state('100'), snap(0)), 'Asia/Shanghai');
  assert.equal(store.due(T).length, 1);
  store.unsubscribe(tg, '100');
  assert.equal(store.due(T).length, 0);
  assert.equal(store.history('100', 1)[0]?.status, 'incomplete');
});
test('database restart keeps sessions and sent markers', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new Store(join(dir, 'test.db'));
  store.subscribe(tg, snap(-10_000, { live: false }));
  store.commit(advance(store.state('100'), snap(0)), 'Asia/Shanghai');
  const session = store.history('100', 1)[0]!.id;
  store.delivered(store.due(T)[0]!.id); store.close();
  store = new Store(join(dir, 'test.db'));
  t.after(() => store.close());
  store.resetDebounce();
  store.commit(advance(store.state('100'), snap(10_000)), 'Asia/Shanghai');
  assert.equal(store.history('100', 1)[0]!.id, session);
  assert.equal(store.due(T + 10_000).length, 0);
});
test('a failed outbox insert rolls back the session and state transition', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.subscribe(tg, snap(-10_000, { live: false }));
  store.db.exec("CREATE TRIGGER fail_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(() => store.commit(advance(store.state('100'), snap(0)), 'Asia/Shanghai'));
  assert.equal(store.state('100')!.live, false);
  assert.equal(store.history('100', 1).length, 0);
});
test('failed Telegram delivery does not repeat successful Discord delivery', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.subscribe(tg, snap(-10_000, { live: false })); store.subscribe(dc, snap(-10_000, { live: false }));
  store.commit(advance(store.state('100'), snap(0)), 'Asia/Shanghai');
  let telegramCalls = 0; let discordCalls = 0;
  const delivery = new Deliverer(store, {
    telegram: { async send() { if (++telegramCalls === 1) throw new RemoteError('429', 1000); } },
    discord: { async send() { discordCalls++; } },
  });
  await delivery.tick(T);
  assert.equal(discordCalls, 1);
  // Re-schedule the simulated retry without depending on the machine's wall clock.
  store.db.prepare("UPDATE deliveries SET next_at=? WHERE status='pending'").run(T + 2000);
  await delivery.tick(T + 2000);
  assert.equal(telegramCalls, 2); assert.equal(discordCalls, 1);
});
test('per-room order, expiry and permanent errors unblock later messages', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.subscribe(tg, snap(-10_000, { live: false }));
  store.commit(advance(store.state('100'), snap(0)), 'Asia/Shanghai');
  for (const n of [10_000, 20_000, 30_000]) store.commit(advance(store.state('100'), snap(n, { title: 'B' })), 'Asia/Shanghai');
  const first = store.due(T + 30_000);
  assert.equal(first.length, 1);
  store.failed(first[0]!.id, '403', T, true);
  assert.equal(store.due(T + 30_000).length, 1);
  assert.equal(store.due(T + 700_000).length, 0);
  assert.match(store.deliveryStats(), /expired/);
});
test('lease excludes a second live instance and expires after a crash', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  assert.equal(store.lease('one', T), true);
  assert.equal(store.lease('two', T + 1000), false);
  assert.equal(store.lease('two', T + 16_000), true);
  store.release('one'); assert.equal(store.lease('three', T + 17_000), false);
  store.release('two'); assert.equal(store.lease('three', T + 17_000), true);
});
test('resubscribing to the same upstream session resumes its incomplete history', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.subscribe(tg, snap(0));
  const id = store.history('100', 1)[0]!.id;
  store.unsubscribe(tg, '100');
  store.subscribe(tg, snap(20_000));
  assert.equal(store.history('100', 1).length, 1);
  assert.equal(store.history('100', 1)[0]!.id, id);
  assert.equal(store.history('100', 1)[0]!.status, 'live');
  assert.equal(store.history('100', 1)[0]!.interrupted, true);
});
