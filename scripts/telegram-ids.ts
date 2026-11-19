/**
 * Discover Telegram chat / user ids.
 * Tắt process chính trước (cùng token không poll 2 lần).
 *
 * Usage: npm run telegram:ids
 * Chat riêng với bot → user id; /id trong forum → forum id.
 */
import { Bot } from 'grammy';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
if (!token) {
  console.error('Thiếu TELEGRAM_BOT_TOKEN trong .env');
  process.exit(1);
}

const bot = new Bot(token);

bot.command('id', async (ctx) => {
  const chat = ctx.chat;
  const from = ctx.from;
  const topic = ctx.message?.message_thread_id;
  const lines = [
    `chat.id = ${chat?.id}`,
    `chat.type = ${chat?.type}`,
    chat && 'title' in chat ? `chat.title = ${chat.title}` : null,
    from ? `from.id = ${from.id} (@${from.username ?? '—'})` : null,
    topic != null ? `message_thread_id = ${topic}` : null,
  ].filter(Boolean);
  console.log(lines.join(' | '));
  await ctx.reply(lines.join('\n'));
});

bot.on('message', async (ctx) => {
  if (ctx.message.text?.startsWith('/')) return;
  const chat = ctx.chat;
  const from = ctx.from;
  console.log(
    `msg chat=${chat?.id} type=${chat?.type} from=${from?.id} topic=${ctx.message.message_thread_id ?? '-'}`,
  );
});

console.log('Đang poll… Chat với bot hoặc gửi /id trong forum/channel.');
await bot.start();
