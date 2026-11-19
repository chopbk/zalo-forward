import { Bot, type Api } from 'grammy';
import { getEnv, isTelegramEnabled } from '../config/env.js';
import logger from '../config/logger.js';

let bot: Bot | null = null;

export function getTelegramApi(): Api | null {
  if (!isTelegramEnabled()) return null;
  if (!bot) {
    const env = getEnv();
    bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  }
  return bot.api;
}

export function getTelegramBot(): Bot | null {
  if (!isTelegramEnabled()) return null;
  if (!bot) {
    const env = getEnv();
    bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  }
  return bot;
}

export function truncateTopicTitle(title: string, max = 128): string {
  const t = title.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t || 'Zalo';
  return `${t.slice(0, max - 1)}…`;
}

export async function verifyTelegramForum(forumGroupId: string): Promise<{
  ok: boolean;
  botUsername?: string;
  title?: string;
  error?: string;
}> {
  const api = getTelegramApi();
  if (!api) {
    return { ok: false, error: 'Thiếu TELEGRAM_BOT_TOKEN trong .env' };
  }
  try {
    const me = await api.getMe();
    const chat = await api.getChat(forumGroupId);
    const isForum =
      typeof chat === 'object' &&
      chat &&
      'is_forum' in chat &&
      Boolean((chat as { is_forum?: boolean }).is_forum);
    if (!isForum) {
      return {
        ok: false,
        botUsername: me.username,
        error: `Chat ${forumGroupId} chưa bật Topics (is_forum)`,
      };
    }
    const title =
      chat && 'title' in chat ? String((chat as { title?: string }).title ?? '') : '';
    logger.info(
      { username: me.username, forum: forumGroupId, title },
      'Telegram forum OK',
    );
    return { ok: true, botUsername: me.username, title: title || undefined };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** @deprecated dùng verifyTelegramForum(forumId) */
export async function verifyTelegramConfig(): Promise<{
  ok: boolean;
  botUsername?: string;
  error?: string;
}> {
  if (!isTelegramEnabled()) {
    return { ok: false, error: 'Thiếu TELEGRAM_BOT_TOKEN' };
  }
  const api = getTelegramApi();
  try {
    const me = await api!.getMe();
    return { ok: true, botUsername: me.username };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
