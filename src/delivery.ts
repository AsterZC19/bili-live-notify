import { RemoteError, type Platform, type Sender } from './model.js';
import { Store } from './store.js';
export class Deliverer {
  private running = false;
  constructor(readonly store: Store, readonly senders: Partial<Record<Platform, Sender>>) {}
  async tick(now = Date.now()) {
    if (this.running) return;
    this.running = true;
    try {
      await Promise.all(this.store.due(now).map(async task => {
        const sender = this.senders[task.target.platform];
        if (!sender || !this.store.pending(task.id)) return;
        try {
          await sender.send(task.target.id, task.message);
          this.store.delivered(task.id);
        } catch (error) {
          const remote = error instanceof RemoteError ? error : new RemoteError('发送失败');
          const wait = remote.retryAfterMs ?? Math.min(300_000, 2000 * 2 ** Math.min(task.attempts, 8));
          this.store.failed(task.id, remote.message, Date.now() + wait, remote.permanent);
        }
      }));
    } finally { this.running = false; }
  }
}
