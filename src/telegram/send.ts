import { InputFile, type Api } from 'grammy';
import logger from '../config/logger.js';
import { findTopicById } from '../db/telegram-topics.js';
import {
  zaloStylesToTelegramHtml,
  type TextStyleSpan,
} from './format.js';
import { downloadMany } from './media.js';
import { getTelegramApi } from './client.js';
import { markTopicMissingFromError } from './topics.js';

export type TelegramSendPayload = {
  topicId: number;
  chatId?: string;
  text?: string;
  styles?: TextStyleSpan[];
  images?: Array<{ url: string }>;
  senderName?: string;
  isSelf?: boolean;
  /** DM Inbox: hiện thêm id để /useradd dễ copy */
  inboxUserId?: string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildHtml(payload: TelegramSendPayload): string {
  const body = payload.text ?? '';
  if (payload.inboxUserId) {
    const who = payload.isSelf
      ? 'Bạn'
      : payload.senderName
        ? escapeHtml(payload.senderName)
        : escapeHtml(payload.inboxUserId);
    const head = `<b>${who}</b>\n<code>${escapeHtml(payload.inboxUserId)}</code>\n`;
    return head + zaloStylesToTelegramHtml(body, payload.styles ?? []);
  }
  const prefix = payload.isSelf
    ? 'Bạn: '
    : payload.senderName
      ? `${payload.senderName}: `
      : '';
  return (
    zaloStylesToTelegramHtml(prefix, []) +
    zaloStylesToTelegramHtml(body, payload.styles ?? [])
  );
}

export async function sendPayloadToTelegramTopic(
  payload: TelegramSendPayload,
): Promise<number | null> {
  const api = getTelegramApi();
  if (!api) {
    throw new Error('Telegram chưa bật (TELEGRAM_BOT_TOKEN)');
  }

  const topic = findTopicById(payload.topicId);
  if (topic?.topicMissing) {
    throw new Error(`Telegram topic #${payload.topicId} missing — dùng recreate`);
  }

  const chatId = payload.chatId ?? topic?.telegramChatId;
  if (!chatId) {
    throw new Error(`Không biết forum chat cho topic #${payload.topicId}`);
  }
  const threadId = payload.topicId;

  if (payload.images && payload.images.length > 0) {
    return sendPhotos(api, chatId, threadId, payload);
  }

  const html = buildHtml(payload).trim();
  if (!html) return null;

  try {
    const sent = await api.sendMessage(chatId, html, {
      message_thread_id: threadId,
      parse_mode: 'HTML',
    });
    logger.info(
      { topicId: threadId, telegramMessageId: sent.message_id },
      'Forwarded Zalo → Telegram topic',
    );
    return sent.message_id;
  } catch (err) {
    markTopicMissingFromError(threadId, err);
    throw err;
  }
}

async function sendPhotos(
  api: Api,
  chatId: string,
  threadId: number,
  payload: TelegramSendPayload,
): Promise<number | null> {
  const urls = (payload.images ?? []).map((i) => i.url).filter(Boolean);
  const caption = buildHtml(payload).trim() || undefined;
  const { buffers, failed } = await downloadMany(urls);

  try {
    if (buffers.length === 0) {
      const sent = await api.sendMessage(
        chatId,
        [
          caption ? `${caption}\n` : '',
          '[Ảnh] Không tải được file từ Zalo — gửi link:',
          ...failed.map((u) => u.slice(0, 200)),
        ].join('\n'),
        { message_thread_id: threadId },
      );
      return sent.message_id;
    }

    if (buffers.length === 1) {
      const sent = await api.sendPhoto(
        chatId,
        new InputFile(buffers[0]!, 'zalo-photo.jpg'),
        {
          message_thread_id: threadId,
          caption: caption || undefined,
          ...(caption ? { parse_mode: 'HTML' as const } : {}),
        },
      );
      return sent.message_id;
    }

    const media = buffers.map((buf, i) => ({
      type: 'photo' as const,
      media: new InputFile(buf, `zalo-photo-${i}.jpg`),
      ...(i === 0 && caption
        ? { caption, parse_mode: 'HTML' as const }
        : {}),
    }));
    const sent = await api.sendMediaGroup(chatId, media, {
      message_thread_id: threadId,
    });
    return sent[0]?.message_id ?? null;
  } catch (err) {
    markTopicMissingFromError(threadId, err);
    throw err;
  }
}
