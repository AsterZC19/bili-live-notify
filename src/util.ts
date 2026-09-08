import { setTimeout as delay } from 'node:timers/promises';
import { RemoteError, type Message } from './model.js';
export { delay };
export const retryDelay = (attempt: number, base = 2000, cap = 60_000) =>
  Math.min(cap, base * 2 ** Math.min(attempt, 8));
export async function repeat(operation: () => Promise<void> | void, interval: number, signal: AbortSignal) {
  while (!signal.aborted) {
    const started = Date.now();
    await operation();
    await delay(Math.max(100, interval - (Date.now() - started)), undefined, { signal }).catch(() => {});
  }
}
export function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : '未知错误';
  for (const [key, value] of Object.entries(process.env)) {
    if (/TOKEN|PASSWORD|SECRET|PROXY/i.test(key) && value) message = message.split(value).join('[已隐藏]');
  }
  return message.replace(/https?:\/\/[^\s]+/g, '[URL已隐藏]').slice(0, 300);
}
export function log(event: string, detail: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...detail }));
}
export async function mediaFallback(message: Message, send: (message: Message) => Promise<void>) {
  try { await send(message); }
  catch (error) {
    if (!(error instanceof RemoteError) || !error.mediaInvalid || !message.image) throw error;
    if (message.fallbackImage) {
      try { await send({ ...message, image: message.fallbackImage, fallbackImage: undefined }); return; }
      catch (fallbackError) {
        if (!(fallbackError instanceof RemoteError) || !fallbackError.mediaInvalid) throw fallbackError;
      }
    }
    await send({ ...message, image: undefined, fallbackImage: undefined,
      text: message.text + '\n（图片暂时无法加载）' });
  }
}
export class SerialTargets {
  private queues = new Map<string, Promise<void>>();
  run(id: string, action: () => Promise<void>): Promise<void> {
    const queued = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.queues.set(id, queued);
    void queued.finally(() => { if (this.queues.get(id) === queued) this.queues.delete(id); }).catch(() => {});
    return queued;
  }
}
