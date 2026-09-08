import { RemoteError, type Platform, type Sender } from './model.js';
import { Store } from './store.js';
import { repeat, retryDelay } from './util.js';

export class Deliverer {
  private running = new Set<Platform>();
  private readonly platforms: Platform[];
  constructor(readonly store: Store, readonly senders: Partial<Record<Platform, Sender>>) {
    this.platforms = (Object.keys(senders) as Platform[]).filter(platform => senders[platform]);
  }
  async tick(now = Date.now()) {
    await Promise.all(this.platforms.map(platform => this.tickPlatform(platform, now)));
  }
  loops(signal: AbortSignal): Promise<void>[] {
    return this.platforms.map(platform =>
      repeat(() => this.tickPlatform(platform, Date.now()), 1000, signal));
  }
  private async tickPlatform(platform: Platform, now: number) {
    if (this.running.has(platform)) return;
    this.running.add(platform);
    try {
      await Promise.all(this.store.due(now, platform).map(async task => {
        if (!this.store.pending(task.id)) return;
        try {
          await this.senders[platform]!.send(task.target.id, task.message);
          this.store.delivered(task.id);
        } catch (error) {
          const remote = error instanceof RemoteError ? error : new RemoteError('发送失败');
          const wait = remote.retryAfterMs ?? retryDelay(task.attempts, 2000, 300_000);
          this.store.failed(task.id, remote.message, Date.now() + wait, remote.permanent);
        }
      }));
    } finally { this.running.delete(platform); }
  }
}
