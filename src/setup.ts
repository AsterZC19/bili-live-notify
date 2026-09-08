import { closeNetwork, request } from './network.js';
import { safeError } from './util.js';
try {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('请先在 .env 中填写 TELEGRAM_BOT_TOKEN');
  const response = await request(`https://api.telegram.org/bot${token}/getUpdates`);
  const payload = await response.json() as {
    ok: boolean; error_code?: number;
    result?: { message?: { from?: { id: number }; chat: { id: number; type: string } } }[];
  };
  if (!payload.ok) throw new Error(`Telegram 返回错误 ${payload.error_code}；请确认 Token 且 Bot 未设置 Webhook`);
  const ids = new Set(payload.result?.filter(u => u.message?.chat.type === 'private' && u.message.from)
    .map(u => String(u.message!.from!.id)));
  if (!ids.size) console.log('没有待处理的私聊消息。请先向 Bot 发送 /start，再运行本命令。');
  else console.log('最近给此 Bot 发过私聊的用户 ID：\n' + [...ids].join('\n') + '\n请确认哪个是你本人的 ID，填写 TELEGRAM_OWNER_ID。');
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
finally { await closeNetwork(); }
