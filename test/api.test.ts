import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Response } from 'undici';
import { Bilibili } from '../src/bilibili.js';
import { Telegram } from '../src/telegram.js';
import { Service } from '../src/service.js';
import { Store } from '../src/store.js';
import { RemoteError } from '../src/model.js';
import { T } from './helpers.js';

test('Bilibili resolves a short room ID then reads its UID via the batch endpoint', async () => {
  const urls: string[] = [];
  const bili = new Bilibili(async url => {
    urls.push(url);
    return new Response(JSON.stringify({ code: 0, data: url.includes('room_init') ? { room_id: 7734200, uid: 50329118 }
      : { '50329118': { uid: 50329118, room_id: 7734200, uname: '主播', title: '直播', live_status: 1,
        live_time: T / 1000, keyframe: 'https://i0.hdslb.com/a.jpg', area_name: '生活娱乐',
        area_v2_id: 371, area_v2_name: '虚拟日常', area_v2_parent_id: 9, area_v2_parent_name: '虚拟主播' } } }));
  });
  const result = await bili.resolve('6');
  assert.equal(result.uid, '50329118'); assert.equal(result.roomId, '7734200');
  assert.deepEqual(result.area, { id: 371, name: '虚拟日常', parentId: 9, parentName: '虚拟主播' });
  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /room_init\?id=6$/);
  assert.equal(new URL(urls[1]!).searchParams.get('uids[]'), '50329118');
});
test('Bilibili distinguishes HTTP, business and malformed JSON errors', async () => {
  for (const body of [{ code: -352, data: null }, { code: 0, data: null }]) {
    const bili = new Bilibili(async () => new Response(JSON.stringify(body)));
    await assert.rejects(bili.statuses(['100']), /接口异常/);
  }
  await assert.rejects(new Bilibili(async () => new Response('bad', { status: 412 })).statuses(['100']), /HTTP 412/);
  await assert.rejects(new Bilibili(async () => new Response('bad')).statuses(['100']), /JSON/);
});
test('Telegram photo→cover→text fallback uses real API response classification', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const service = new Service(store, 'Asia/Shanghai');
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const bot = new Telegram({ token: 'test-token', owner: '123' }, service, async (url, options) => {
    const method = url.split('/').at(-1)!;
    calls.push({ method, body: JSON.parse(options!.body!) as Record<string, unknown> });
    return new Response(JSON.stringify(method === 'sendPhoto'
      ? { ok: false, error_code: 400, description: 'Bad Request: failed to get HTTP URL content' }
      : { ok: true, result: {} }));
  });
  await bot.send('123', { text: 'title <b>@name</b>', image: 'https://i0.hdslb.com/a.jpg', fallbackImage: 'https://i0.hdslb.com/b.jpg' });
  assert.deepEqual(calls.map(c => c.method), ['sendPhoto', 'sendPhoto', 'sendMessage']);
  assert.equal(calls[2]!.body.parse_mode, undefined);
  assert.match(String(calls[2]!.body.text), /<b>@name<\/b>/);
  bot.stop();
});
test('Telegram preserves retry_after and permanent permission failures', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const code of [429, 403]) {
    const bot = new Telegram({ token: 'test-token', owner: '123' }, new Service(store, 'Asia/Shanghai'), async () =>
      new Response(JSON.stringify({ ok: false, error_code: code, parameters: { retry_after: 5 } })));
    await assert.rejects(bot.send('123', { text: 'test' }), error => error instanceof RemoteError &&
      error.retryAfterMs === 5000 && error.permanent === (code === 403));
    bot.stop();
  }
});
test('Telegram long polling accepts owner commands and persists consumed offset', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let updates = 0; let sends = 0;
  let bot: Telegram;
  bot = new Telegram({ token: 'test-token', owner: '123' }, new Service(store, 'Asia/Shanghai'), async (url, options) => {
    const method = url.split('/').at(-1);
    let result: unknown = {};
    if (method === 'getWebhookInfo') result = { url: '' };
    if (method === 'getUpdates') {
      if (++updates === 1) result = [
        { update_id: 1, message: { from: { id: 999 }, chat: { id: 999, type: 'private' }, text: '/test' } },
        { update_id: 2, message: { from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/test' } },
      ];
      else {
        assert.equal(JSON.parse(options!.body!).offset, 3); bot.stop(); result = [];
      }
    }
    if (method === 'sendMessage') sends++;
    return new Response(JSON.stringify({ ok: true, result }));
  });
  await bot.run();
  assert.equal(sends, 1); assert.equal(store.getMeta('telegram_offset'), '3');
});
