import type { LiveEvent, Message, Session } from './model.js';
export const duration = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}小时${Math.floor(s % 3600 / 60)}分${s % 60}秒`;
};
export const clip = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s;
export function time(value: number | null, zone: string) {
  return value === null ? '未知' : new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(value);
}
export function sessionText(session: Session, zone: string, now = Date.now()): string {
  const start = `${time(session.startedAt, zone)}${session.startSource === 'observed' ? '（估算）' : ''}`;
  const end = session.status === 'live' ? '直播中' : session.endedAt === null
    ? `未知（末次直播 ${time(session.lastLiveAt, zone)}；首次离线 ${time(session.firstOfflineAt, zone)}）`
    : `${time(session.endedAt, zone)}（估算）`;
  const elapsed = session.status === 'live' ? duration((now - session.startedAt) / 1000)
    : session.durationSeconds === null ? '未知' : `${duration(session.durationSeconds)}（估算）`;
  return `开播：${start}\n结束：${end}\n${session.status === 'live' ? '已播' : '时长'}：${elapsed}` +
    (session.joinedLate ? '\n中途开始监测' : '') + (session.interrupted ? '\n记录不完整：监测曾中断' : '');
}
export function eventMessage(event: LiveEvent, zone: string): Message {
  const s = event.snapshot;
  const url = `https://live.bilibili.com/${s.roomId}`;
  const name = clip(s.name, 100);
  if (event.kind === 'start') return {
    text: `🔴 ${name} 开播了\n${clip(s.title, 250)}\n开播：${time(event.session.startedAt, zone)}` +
      (event.session.startSource === 'observed' ? '（估算）' : '') + `\n${url}`,
    image: s.keyframe ?? s.cover ?? undefined,
    fallbackImage: s.keyframe ? s.cover ?? undefined : undefined, url,
  };
  if (event.kind === 'end') return { text: `⚫ ${name} 下播了\n${sessionText(event.session, zone)}\n${url}`, url };
  return { text: `📝 ${name} 修改了标题\n原：${clip(event.oldTitle ?? '', 250)}\n新：${clip(event.newTitle ?? '', 250)}\n${url}`, url };
}
