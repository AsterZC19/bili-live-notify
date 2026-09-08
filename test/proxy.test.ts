import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

test('HTTP API and Gateway HTTPS agent use CONNECT proxy and honor NO_PROXY', async () => {
  const keys = ['https_proxy', 'http_proxy', 'all_proxy', 'no_proxy', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'];
  const original = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const connects: string[] = [];
  const proxy = http.createServer((_req, res) => res.writeHead(502).end());
  proxy.on('clientError', (_error, socket) => socket.destroy());
  proxy.on('connect', (req, socket) => {
    connects.push(req.url!);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as AddressInfo).port;
  process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
  process.env.NO_PROXY = '127.0.0.1';
  const network = await import('../src/network.js');
  network.configureGatewayProxy();
  try {
    await assert.rejects(network.request('https://api.telegram.invalid/getMe', { timeout: 2000 }));
    assert.ok(connects.includes('api.telegram.invalid:443'));
    const nodeRequest = (url: string) => new Promise<void>((resolve, reject) => {
      const req = https.get(url, res => {
        res.resume();
        if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}`)); else resolve();
      });
      req.setTimeout(2000, () => req.destroy(new Error('timeout')));
      req.once('error', reject);
    });
    await assert.rejects(nodeRequest('https://gateway.discord.invalid/'));
    assert.ok(connects.includes('gateway.discord.invalid:443'));
    const count = connects.length;
    await assert.rejects(nodeRequest(`https://127.0.0.1:${port}/`));
    await assert.rejects(network.request(`https://127.0.0.1:${port}/`, { timeout: 2000 }));
    assert.equal(connects.length, count);
  } finally {
    await network.closeNetwork();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
