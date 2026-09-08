import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';

test('runtime stays healthy with upstream failures, shuts down cleanly, and releases its lease', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-runtime-'));
  const proxy = http.createServer();
  proxy.on('connect', (_req, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as AddressInfo).port;
  const reserve = http.createServer();
  await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = (reserve.address() as AddressInfo).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/proxy|TELEGRAM_|DISCORD_/i.test(key)) delete env[key];
  }
  const database = join(dir, 'app.db');
  const child = spawn(process.execPath, ['--import=tsx', 'src/main.ts'], {
    cwd: process.cwd(), env: { ...env, TELEGRAM_BOT_TOKEN: 'not-a-real-token', TELEGRAM_OWNER_ID: '123',
      DISCORD_BOT_TOKEN: 'not-a-real-token', DISCORD_OWNER_ID: '123', DISCORD_GUILD_ID: '456',
      DATABASE_PATH: database, HEALTH_PORT: String(port), HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: 'localhost,127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  const exited = once(child, 'exit');
  try {
    let healthy = false;
    for (let n = 0; n < 40; n++) {
      try { healthy = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { /* startup */ }
      if (healthy) break;
      await delay(100);
    }
    assert.equal(healthy, true, output);
    await delay(300);
    assert.match(output, /telegram_error/);
    assert.match(output, /discord_error/);
    assert.equal(output.includes('not-a-real-token'), false);
    child.kill('SIGTERM');
    const [code, signal] = await Promise.race([exited, delay(6000, undefined, { ref: false }).then(() => { throw new Error(`shutdown timed out: ${output}`); })]);
    assert.equal(code, 0, output); assert.equal(signal, null, output);
    const store = new Store(database);
    try { assert.equal(store.getMeta('lease'), undefined); } finally { store.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
