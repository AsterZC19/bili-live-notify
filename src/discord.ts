import { Client, GatewayDispatchEvents, GatewayIntentBits, InteractionType, ApplicationCommandOptionType,
  ApplicationCommandType, ChannelType, MessageFlags, Routes,
  type APIChatInputApplicationCommandInteraction, type RESTPostAPIChatInputApplicationCommandsJSONBody } from '@discordjs/core';
import { REST, RateLimitError } from '@discordjs/rest';
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import type { Config } from './config.js';
import { clip } from './format.js';
import { RemoteError, type Message, type Sender } from './model.js';
import { dispatcher } from './network.js';
import { commandDescriptions, Service } from './service.js';
import { delay, log, mediaFallback, safeError, SerialTargets } from './util.js';

export function discordAllowed(user: string | undefined, guild: string | undefined, channelType: number,
  settings: { owner: string; guild: string }): boolean {
  return user === settings.owner && guild === settings.guild && channelType === ChannelType.GuildText;
}
function discordError(error: unknown): RemoteError {
  if (error instanceof RateLimitError) return new RemoteError('Discord 请求限流',
    Math.max(error.retryAfter, error.timeToReset, error.sublimitTimeout, 1000));
  const e = error as { status?: number; code?: number; retry_after?: number };
  return new RemoteError(`Discord 请求失败${e.status ? ` HTTP ${e.status}` : ''}${e.code ? `（${e.code}）` : ''}`,
    e.retry_after ? e.retry_after * 1000 : undefined, [400, 401, 403, 404].includes(e.status ?? 0),
    e.status === 400 && e.code === 50035);
}
const escape = (text: string) => text.replace(/[\\`*_~|>\[\]]/g, '\\$&');
export function discordBody(message: Message) {
  return { allowed_mentions: { parse: [] as never[] }, embeds: [{
    description: clip(escape(message.text), 4000),
    ...(message.image ? { image: { url: message.image } } : {}),
  }] };
}
export class Discord implements Sender {
  private abort = new AbortController();
  private rest: REST;
  private gateway: WebSocketManager;
  private client: Client;
  private queue = new SerialTargets();
  private interactions = new Set<string>();
  constructor(private settings: NonNullable<Config['discord']>, private service: Service) {
    this.rest = new REST({ version: '10', timeout: 10_000, retries: 0,
      rejectOnRateLimit: data => data.route.includes('/channels/') && data.route.includes('/messages'),
    }).setToken(settings.token).setAgent(dispatcher);
    this.gateway = new WebSocketManager({ token: settings.token, rest: this.rest,
      intents: GatewayIntentBits.Guilds, shardCount: 1, shardIds: [0] });
    this.client = new Client({ rest: this.rest, gateway: this.gateway });
    this.gateway.on(WebSocketShardEvents.Ready, () => { service.connections.discord = '已连接'; });
    this.gateway.on(WebSocketShardEvents.Resumed, () => { service.connections.discord = '已连接'; });
    this.gateway.on(WebSocketShardEvents.Closed, () => { service.connections.discord = '连接中断，等待恢复'; });
    this.gateway.on(WebSocketShardEvents.Error, () => { service.connections.discord = 'Gateway 连接异常'; });
    this.client.on(GatewayDispatchEvents.InteractionCreate, ({ data }) => {
      if (data.type !== InteractionType.ApplicationCommand || data.data.type !== ApplicationCommandType.ChatInput) return;
      void this.handle(data as APIChatInputApplicationCommandInteraction).catch(error => {
        log('discord_command_error', { error: safeError(discordError(error)) });
      });
    });
  }
  private async handle(data: APIChatInputApplicationCommandInteraction) {
    if (this.abort.signal.aborted || this.interactions.has(data.id)) return;
    if (this.interactions.size >= 1000) this.interactions.delete(this.interactions.values().next().value!);
    this.interactions.add(data.id);
    const user = data.member?.user.id ?? data.user?.id;
    if (!discordAllowed(user, data.guild_id, data.channel?.type ?? -1, this.settings)) {
      await this.client.api.interactions.reply(data.id, data.token, { content: '此 Bot 仅供配置的本人在指定服务器文字频道使用。', flags: MessageFlags.Ephemeral });
      return;
    }
    await this.client.api.interactions.defer(data.id, data.token, { flags: MessageFlags.Ephemeral });
    const source = data.data.options?.find(o => o.name === 'source');
    const page = data.data.options?.find(o => o.name === 'page');
    let messages: Message[];
    try {
      messages = await this.service.command({ platform: 'discord', id: data.channel.id }, data.data.name,
        source && 'value' in source ? String(source.value) : '', page && 'value' in page ? Number(page.value) : 1);
      if (data.data.name === 'test') {
        await this.send(data.channel.id, messages[0]!);
        messages = [{ text: '已向当前频道发送测试通知。' }];
      }
    } catch (error) { messages = [{ text: safeError(error) }]; }
    for (const [index, message] of messages.entries()) {
      await mediaFallback(message, async m => {
        try {
          if (index === 0) await this.client.api.interactions.editReply(data.application_id, data.token, discordBody(m));
          else await this.client.api.interactions.followUp(data.application_id, data.token, { ...discordBody(m), flags: MessageFlags.Ephemeral });
        } catch (error) { throw discordError(error); }
      });
    }
  }
  async send(targetId: string, message: Message): Promise<void> {
    return this.queue.run(targetId, () => mediaFallback(message, async m => {
      try { await this.client.api.channels.createMessage(targetId, discordBody(m)); }
      catch (error) { throw discordError(error); }
    }));
  }
  async run() {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        const app = await this.rest.get(Routes.oauth2CurrentApplication()) as { id: string };
        const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = Object.entries(commandDescriptions).map(([name, description]) => ({
          name, description, type: ApplicationCommandType.ChatInput,
          options: ['subscribe', 'unsubscribe', 'frame', 'history'].includes(name) ? [
            { name: 'source', description: '房间号、直播间链接、uid:数字或个人空间链接', type: ApplicationCommandOptionType.String, required: true },
            ...(name === 'history' ? [{ name: 'page', description: '页码，每页10条', type: ApplicationCommandOptionType.Integer as const, min_value: 1, max_value: 100000 }] : []),
          ] : [],
        }));
        const signature = JSON.stringify(commands);
        const metaKey = `discord_commands:${app.id}:${this.settings.guild}`;
        if (this.service.store.getMeta(metaKey) !== signature) {
          await this.client.api.applicationCommands.bulkOverwriteGuildCommands(app.id, this.settings.guild, commands);
          this.service.store.setMeta(metaKey, signature);
        }
        await this.gateway.connect();
        await new Promise<void>(resolve => {
          if (this.abort.signal.aborted) resolve();
          else this.abort.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      } catch (error) {
        if (this.abort.signal.aborted) break;
        this.service.connections.discord = discordError(error).message;
        log('discord_error', { error: discordError(error).message });
        await Promise.resolve(this.gateway.destroy()).catch(() => {});
        await delay(Math.min(60_000, 2000 * 2 ** Math.min(failures++, 5)), undefined, { signal: this.abort.signal }).catch(() => {});
      }
    }
  }
  async stop() {
    this.abort.abort(); await this.gateway.destroy();
    this.rest.clearHashSweeper(); this.rest.clearHandlerSweeper();
  }
}
