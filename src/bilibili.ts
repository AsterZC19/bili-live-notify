import { request } from './network.js';
import { RemoteError, type Snapshot } from './model.js';

const API = 'https://api.live.bilibili.com';
export const imageUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (!['http:', 'https:'].includes(url.protocol) ||
        !(url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com'))) return null;
    url.protocol = 'https:';
    return url.toString();
  } catch { return null; }
};
export function startTime(value: unknown, now: number): number | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 946684800 && seconds * 1000 <= now + 60_000
    ? Math.floor(seconds * 1000) : null;
}
export function parseSnapshot(uid: string, raw: unknown, now: number): Snapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!/^[1-9]\d*$/.test(String(r.room_id)) || String(r.uid) !== uid ||
      ![0, 1, 2].includes(Number(r.live_status)) || r.live_status == null ||
      typeof r.title !== 'string' || typeof r.uname !== 'string') return null;
  return { uid, roomId: String(r.room_id), name: r.uname, title: r.title,
    live: Number(r.live_status) === 1, startedAt: startTime(r.live_time, now),
    keyframe: imageUrl(r.keyframe), cover: imageUrl(r.cover_from_user), observedAt: now };
}
export function parseSource(input: string): { type: 'uid' | 'room'; id: string } {
  const value = input.trim();
  if (/^[1-9]\d*$/.test(value)) return { type: 'room', id: value };
  if (/^uid:[1-9]\d*$/i.test(value)) return { type: 'uid', id: value.slice(4) };
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
    const id = url.pathname.match(/^\/([1-9]\d*)\/?$/)?.[1];
    if (id && url.hostname === 'live.bilibili.com') return { type: 'room', id };
    if (id && url.hostname === 'space.bilibili.com') return { type: 'uid', id };
  } catch { /* handled below */ }
  throw new Error('请输入直播间链接、房间号、uid:数字或个人空间链接（不支持短链接）');
}
export class Bilibili {
  constructor(private readonly transport: typeof request = request) {}
  private async get(path: string): Promise<Record<string, unknown>> {
    const response = await this.transport(API + path, { headers: {
      'User-Agent': 'Mozilla/5.0', Referer: 'https://live.bilibili.com/',
    } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RemoteError(`Bilibili HTTP ${response.status}`);
    }
    let result: { code?: number; data?: unknown };
    try { result = await response.json() as typeof result; }
    catch { throw new RemoteError('Bilibili 返回无效 JSON'); }
    if (result.code !== 0 || !result.data || typeof result.data !== 'object') {
      throw new RemoteError(`Bilibili 接口异常：${result.code ?? '无状态码'}`);
    }
    return result.data as Record<string, unknown>;
  }
  async statuses(uids: string[], now = Date.now()): Promise<Map<string, Snapshot>> {
    const result = new Map<string, Snapshot>();
    for (let i = 0; i < uids.length; i += 50) {
      const batch = uids.slice(i, i + 50);
      const query = new URLSearchParams();
      for (const uid of batch) query.append('uids[]', uid);
      const data = await this.get(`/room/v1/Room/get_status_info_by_uids?${query}`);
      for (const uid of batch) {
        const snapshot = parseSnapshot(uid, data[uid], now);
        if (snapshot) result.set(uid, snapshot);
      }
    }
    return result;
  }
  async resolve(input: string): Promise<Snapshot> {
    const source = parseSource(input);
    let uid = source.id;
    if (source.type === 'room') {
      const room = await this.get(`/room/v1/Room/room_init?id=${source.id}`);
      uid = String(room.uid);
      if (!/^[1-9]\d*$/.test(uid)) throw new Error('直播间不存在');
    }
    const snapshot = (await this.statuses([uid])).get(uid);
    if (!snapshot) throw new Error('未找到有效直播间，或暂时无法取得状态');
    return snapshot;
  }
}
