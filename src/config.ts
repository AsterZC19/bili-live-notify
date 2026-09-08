export interface Config {
  database: string; pollMs: number; timezone: string; healthPort: number;
  telegram?: { token: string; owner: string };
  discord?: { token: string; owner: string; guild: string };
}
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const positive = (key: string, fallback: number, min: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min) throw new Error(`${key} 必须是 >= ${min} 的整数`);
    return value;
  };
  const part = (keys: string[]) => {
    const values = keys.map(k => env[k]?.trim() ?? '');
    if (values.some(Boolean) && !values.every(Boolean)) throw new Error(`请完整配置 ${keys.join(', ')}`);
    return values.every(Boolean) ? values : undefined;
  };
  const tg = part(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_ID']);
  const dc = part(['DISCORD_BOT_TOKEN', 'DISCORD_OWNER_ID', 'DISCORD_GUILD_ID']);
  if (!tg && !dc) throw new Error('至少配置一个 Bot');
  for (const id of [tg?.[1], dc?.[1], dc?.[2]]) {
    if (id !== undefined && !/^\d+$/.test(id)) throw new Error('用户和服务器 ID 必须为数字');
  }
  const timezone = env.TZ || 'Asia/Shanghai';
  new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format();
  const healthPort = positive('HEALTH_PORT', 8080, 1);
  if (healthPort > 65535) throw new Error('HEALTH_PORT 超出范围');
  return {
    database: env.DATABASE_PATH || '/data/bili.db',
    pollMs: positive('POLL_INTERVAL_SECONDS', 10, 5) * 1000, timezone, healthPort,
    telegram: tg ? { token: tg[0]!, owner: tg[1]! } : undefined,
    discord: dc ? { token: dc[0]!, owner: dc[1]!, guild: dc[2]! } : undefined,
  };
}
