import { Bilibili, parseSource } from './bilibili.js';
import { clip, duration, sessionText, time } from './format.js';
import type { Message, Snapshot, Target } from './model.js';
import { advance } from './state.js';
import { Store } from './store.js';

export const commandDescriptions: Record<string, string> = {
  subscribe: '订阅主播到当前聊天', unsubscribe: '取消当前聊天的主播订阅', list: '查看订阅列表',
  live: '查看正在直播的主播', frame: '获取直播关键帧', history: '查看直播场次记录',
  status: '查看服务状态', test: '发送测试消息', help: '查看使用说明',
};
export interface Source { statuses(uids: string[], now?: number): Promise<Map<string, Snapshot>>; resolve(input: string): Promise<Snapshot> }
export class Service {
  lastPollAttempt = 0;
  lastPollSuccess = 0;
  lastPollError: string | null = null;
  readonly connections: Record<string, string> = {};
  private polling = false;
  private onDemand = new Map<string, Promise<Snapshot>>();
  private recent = new Map<string, Snapshot>();
  constructor(readonly store: Store, readonly timezone: string, readonly bili: Source = new Bilibili(), readonly maxGapMs = 30_000) {}
  async poll(now = Date.now()): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.lastPollAttempt = now;
    try {
      const uids = this.store.states().map(s => s.uid);
      const snapshots = await this.bili.statuses(uids, now);
      for (const uid of uids) {
        const snapshot = snapshots.get(uid);
        if (!snapshot || !this.store.targets(uid).length) continue;
        this.store.commit(advance(this.store.state(uid), snapshot, this.maxGapMs), this.timezone);
      }
      if (uids.length && !snapshots.size) throw new Error('主播状态缺失，已保留原状态');
      this.lastPollSuccess = now;
      this.lastPollError = snapshots.size < uids.length ? '部分主播状态缺失，已保留原状态' : null;
    } catch (error) {
      this.lastPollError = error instanceof Error ? error.message : '检测失败';
      throw error;
    } finally { this.polling = false; }
  }
  private async snapshot(input: string): Promise<Snapshot> {
    const parsed = parseSource(input);
    const key = `${parsed.type}:${parsed.id}`;
    const uid = this.store.knownUid(parsed.type, parsed.id);
    const cached = (uid ? this.store.state(uid)?.snapshot : null) ?? this.recent.get(key);
    if (cached && Date.now() - cached.observedAt <= 10_000) return cached;
    const existing = this.onDemand.get(key);
    if (existing) return existing;
    const promise = this.bili.resolve(input).then(s => {
      if (this.recent.size >= 100) this.recent.delete(this.recent.keys().next().value!);
      this.recent.set(key, s); return s;
    }).finally(() => { this.onDemand.delete(key); });
    this.onDemand.set(key, promise);
    return promise;
  }
  private async uid(input: string): Promise<string> {
    const parsed = parseSource(input);
    return this.store.knownUid(parsed.type, parsed.id) ?? (await this.snapshot(input)).uid;
  }
  async command(target: Target, command: string, source = '', page = 1): Promise<Message[]> {
    if (['subscribe', 'unsubscribe', 'frame', 'history'].includes(command) && !source) {
      return [{ text: `用法：/${command} <直播间链接、房间号或 uid:数字>${command === 'history' ? ' [页码]' : ''}` }];
    }
    switch (command) {
      case 'subscribe': {
        const snapshot = await this.snapshot(source);
        const added = this.store.subscribe(target, snapshot);
        return [{ text: `${added ? '已订阅' : '已经订阅'} ${clip(snapshot.name, 100)}\n房间：${snapshot.roomId} / UID：${snapshot.uid}\n` +
          (snapshot.live ? `正在直播：${clip(snapshot.title, 250)}` : '当前未直播') }];
      }
      case 'unsubscribe': return [{ text: this.store.unsubscribe(target, await this.uid(source)) ? '已取消订阅' : '当前聊天没有此订阅' }];
      case 'list': case 'live': {
        const states = this.store.states(target).filter(s => command === 'list' || s.snapshot.live);
        if (!states.length) return [{ text: command === 'list' ? '还没有订阅，使用 /subscribe 添加主播。' : '最近一次检测没有正在直播的订阅主播。' }];
        const chunks: Message[] = [];
        for (let i = 0; i < states.length; i += 5) chunks.push({ text: states.slice(i, i + 5).map(s => {
          const live = s.snapshot.live;
          const start = s.session?.startedAt ?? s.snapshot.startedAt;
          return `${live ? '🔴' : '⚫'} ${clip(s.snapshot.name, 80)}（${s.snapshot.roomId}）\n` +
            (live ? `${clip(s.snapshot.title, 120)}\n${start ? `开播：${time(start, this.timezone)} / 已播 ${duration((Date.now() - start) / 1000)}\n` : ''}` : '') +
            `状态查询：${time(s.snapshot.observedAt, this.timezone)}\nhttps://live.bilibili.com/${s.snapshot.roomId}`;
        }).join('\n\n') });
        return chunks;
      }
      case 'frame': {
        const s = await this.snapshot(source);
        if (!s.live) return [{ text: `${clip(s.name, 100)} 当前未直播。` }];
        if (!s.keyframe) return [{ text: `${clip(s.name, 100)} 正在直播，但 Bilibili 暂未提供关键帧。` }];
        return [{ text: `${clip(s.name, 100)} 的直播关键帧\n${clip(s.title, 250)}\n查询时间：${time(s.observedAt, this.timezone)}\n画面由 Bilibili 更新，可能有延迟。\nhttps://live.bilibili.com/${s.roomId}`,
          image: s.keyframe, url: `https://live.bilibili.com/${s.roomId}` }];
      }
      case 'history': {
        if (!Number.isSafeInteger(page) || page < 1 || page > 100000) return [{ text: '页码必须是 1～100000 的整数' }];
        const sessions = this.store.history(await this.uid(source), page);
        if (!sessions.length) return [{ text: '这一页没有场次记录。仅记录服务实际监测过的场次。' }];
        // Separate records avoid Telegram's text and Discord's embed limits.
        return sessions.map((s, i) => ({ text: `第 ${page} 页 · ${(page - 1) * 10 + i + 1}\n${clip(s.name, 100)} · ${clip(s.initialTitle, 180)}\n${sessionText(s, this.timezone)}` }));
      }
      case 'status': return [{ text: `监测主播：${this.store.states().length}\n最后成功检测：${time(this.lastPollSuccess || null, this.timezone)}\n` +
        `检测状态：${this.lastPollError ?? '正常'}\n${Object.entries(this.connections).map(([p, s]) => `${p}：${s}`).join('\n')}\n投递：${this.store.deliveryStats()}\n显示时区：${this.timezone}` }];
      case 'test': return [{ text: '✅ 测试成功，当前聊天可以接收直播通知。' }];
      default: return [{ text: Object.entries(commandDescriptions).map(([k, v]) => `/${k} — ${v}`).join('\n') +
        '\n\n主播格式：房间号、直播间链接、uid:数字、个人空间链接。\n纯数字是房间号。两端订阅独立；关键帧图片不在本地归档。' }];
    }
  }
}
