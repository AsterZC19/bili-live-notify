import type { Config } from './config.js';
import { clip } from './format.js';
import { RemoteError, type Message, type Sender } from './model.js';
import { request } from './network.js';
import { commandDescriptions, Service } from './service.js';
import { delay, log, mediaFallback, safeError, SerialTargets } from './util.js';

interface Update {
  update_id: number;
  message?: { from?: { id: number }; chat: { id: number; type: string }; text?: string };
}
export function telegramCommand(update: Update, owner: string): { id: string; command: string; source: string; page: number } | null {
  const m = update.message;
  if (!m || String(m.from?.id) !== owner || m.chat.type !== 'private' || String(m.chat.id) !== owner) return null;
  const match = m.text?.trim().match(/^\/([a-z]+)(?:@[a-zA-Z0-9_]+)?(?:\s+(.*))?$/);
  if (!match) return null;
  const args = (match[2] ?? '').trim().split(/\s+/);
  return { id: String(m.chat.id), command: match[1]!, source: args[0] ?? '', page: args[1] === undefined ? 1 : Number(args[1]) };
}
export class Telegram implements Sender {
  private abort = new AbortController();
  private queue = new SerialTargets();
  private lastSend = new Map<string, number>();
  constructor(private settings: NonNullable<Config['telegram']>, private service: Service,
    private readonly transport: typeof request = request) {}
  private async api<T>(method: string, body: Record<string, unknown> = {}, longPoll = false): Promise<T> {
    const response = await this.transport(`https://api.telegram.org/bot${this.settings.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      timeout: longPoll ? 50_000 : 10_000, signal: this.abort.signal,
    });
    let result: { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    try { result = await response.json() as typeof result; }
    catch { throw new RemoteError(`Telegram 返回无效响应（HTTP ${response.status}）`); }
    if (!result.ok) {
      const code = result.error_code ?? response.status;
      const media = code === 400 && /photo|image|file|HTTP URL|WEBPAGE|MEDIA/i.test(result.description ?? '');
      throw new RemoteError(`Telegram API 错误 ${code}`, result.parameters?.retry_after
        ? result.parameters.retry_after * 1000 : undefined, [400, 401, 403, 404, 409].includes(code), media);
    }
    return result.result as T;
  }
  async send(targetId: string, message: Message): Promise<void> {
    return this.queue.run(targetId, async () => {
      await delay(Math.max(0, 1100 - (Date.now() - (this.lastSend.get(targetId) ?? 0))));
      try {
        await mediaFallback(message, async m => {
          if (m.image) await this.api('sendPhoto', { chat_id: targetId, photo: m.image, caption: clip(m.text, 1000) });
          else await this.api('sendMessage', { chat_id: targetId, text: clip(m.text, 4000) });
        });
        this.service.connections.telegram = '已连接';
      } finally { this.lastSend.set(targetId, Date.now()); }
    });
  }
  async run() {
    let initialized = false;
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        if (!initialized) {
          await this.api('getMe');
          const webhook = await this.api<{ url: string }>('getWebhookInfo');
          if (webhook.url) throw new RemoteError('此 Bot 已设置 Webhook，请先手动移除后使用长轮询', undefined, true);
          await this.api('setMyCommands', { commands: Object.entries(commandDescriptions).map(([command, description]) => ({ command, description })) });
          initialized = true;
        }
        const offset = Number(this.service.store.getMeta('telegram_offset') ?? '0');
        const updates = await this.api<Update[]>('getUpdates', { offset, timeout: 40, allowed_updates: ['message'], limit: 20 }, true);
        if (!Array.isArray(updates)) throw new RemoteError('Telegram updates 格式异常');
        this.service.connections.telegram = '已连接'; failures = 0;
        for (const update of updates) {
          if (this.abort.signal.aborted) break;
          const command = telegramCommand(update, this.settings.owner);
          if (command) {
            try {
              let messages: Message[];
              try { messages = await this.service.command({ platform: 'telegram', id: command.id }, command.command, command.source, command.page); }
              catch (error) { messages = [{ text: safeError(error) }]; }
              for (const message of messages) {
                try { await this.send(command.id, message); }
                catch (error) {
                  if (error instanceof RemoteError && error.retryAfterMs && error.retryAfterMs <= 60_000) {
                    await delay(error.retryAfterMs, undefined, { signal: this.abort.signal });
                    await this.send(command.id, message);
                  } else throw error;
                }
              }
            } catch (error) { log('telegram_command_error', { error: safeError(error) }); }
          }
          this.service.store.setMeta('telegram_offset', String(update.update_id + 1));
        }
      } catch (error) {
        if (this.abort.signal.aborted) break;
        this.service.connections.telegram = safeError(error);
        log('telegram_error', { error: safeError(error) });
        const wait = error instanceof RemoteError && error.retryAfterMs ? error.retryAfterMs
          : Math.min(60_000, 2000 * 2 ** Math.min(failures++, 5));
        await delay(wait, undefined, { signal: this.abort.signal }).catch(() => {});
      }
    }
  }
  stop() { this.abort.abort(); }
}
