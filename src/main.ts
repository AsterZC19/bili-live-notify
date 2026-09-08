import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { Deliverer } from './delivery.js';
import { closeNetwork, configureGatewayProxy } from './network.js';
import { Service } from './service.js';
import { Store } from './store.js';
import { delay, log, safeError } from './util.js';

async function main() {
  const settings = config();
  configureGatewayProxy();
  const store = new Store(settings.database);
  const owner = randomUUID();
  // A hard-killed instance leaves at most a 15-second lease. Graceful shutdown releases immediately.
  let acquired = store.lease(owner);
  for (let attempt = 0; !acquired && attempt < 8; attempt++) {
    await delay(2000); acquired = store.lease(owner);
  }
  if (!acquired) { store.close(); throw new Error('同一数据库已有运行中的实例'); }
  store.resetDebounce();
  const service = new Service(store, settings.timezone, undefined, Math.max(30_000, settings.pollMs * 3));
  const telegram = settings.telegram ? new (await import('./telegram.js')).Telegram(settings.telegram, service) : undefined;
  const discord = settings.discord ? new (await import('./discord.js')).Discord(settings.discord, service) : undefined;
  if (telegram) service.connections.telegram = '正在连接';
  if (discord) service.connections.discord = '正在连接';
  const deliverer = new Deliverer(store, { telegram, discord });
  const abort = new AbortController();
  const signal = abort.signal;
  let heartbeat = Date.now();
  const server = createServer((req, res) => {
    if (req.url !== '/healthz') { res.writeHead(404).end(); return; }
    let healthy = false;
    try { healthy = !signal.aborted && Date.now() - heartbeat < 10_000 && store.healthy(); } catch { /* unhealthy */ }
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' })
      .end(JSON.stringify({ healthy }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(settings.healthPort, '127.0.0.1', resolve);
  });
  let stopping: Promise<void> | undefined;
  const tasks: Promise<unknown>[] = [];
  const stop = (): Promise<void> => stopping ??= (async () => {
    log('stopping'); abort.abort(); telegram?.stop();
    const forced = setTimeout(() => { log('shutdown_timeout'); process.exit(1); }, 15_000);
    server.close();
    await discord?.stop().catch(() => {});
    await Promise.allSettled(tasks);
    store.release(owner); store.close();
    await closeNetwork(); clearTimeout(forced);
    log('stopped');
  })();
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  const loop = (operation: () => Promise<void> | void, interval: number) => (async () => {
    while (!signal.aborted) {
      const started = Date.now();
      await operation();
      await delay(Math.max(100, interval - (Date.now() - started)), undefined, { signal }).catch(() => {});
    }
  })();
  let failures = 0;
  tasks.push((async () => {
    while (!signal.aborted) {
      const started = Date.now();
      try { await service.poll(); failures = 0; }
      catch (error) { failures++; log('poll_error', { error: safeError(error) }); }
      const wait = failures ? Math.min(300_000, settings.pollMs * 2 ** Math.min(failures, 8)) : settings.pollMs;
      await delay(Math.max(100, wait - (Date.now() - started)), undefined, { signal }).catch(() => {});
    }
  })());
  tasks.push(loop(() => deliverer.tick(), 1000));
  tasks.push(loop(() => {
    if (!store.lease(owner)) throw new Error('失去数据库实例租约');
    heartbeat = Date.now();
  }, 2000));
  tasks.push(loop(() => store.cleanup(Date.now()), 3600_000));
  if (telegram) tasks.push(telegram.run());
  if (discord) tasks.push(discord.run());
  for (const task of tasks) void task.catch(error => {
    log('fatal', { error: safeError(error) }); process.exitCode = 1; void stop();
  });
  log('started', { platforms: Object.keys(service.connections), pollSeconds: settings.pollMs / 1000 });
}

main().catch(error => { log('startup_failed', { error: safeError(error) }); process.exit(1); });
