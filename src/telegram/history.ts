import type { Api } from 'grammy';
import logger from '../config/logger.js';
import { claimProcessedMessage } from '../db/processed.js';
import { findMessageLinkByZalo } from '../db/message-links.js';
import type { TelegramTopic } from '../db/telegram-topics.js';
import type { PersonalAccountAdapter } from '../personal/adapter.js';
import { sendPayloadToTelegramTopic } from './send.js';
import { upsertMessageLink } from '../db/message-links.js';

export const GROUP_HISTORY_DEFAULT_LIMIT = 50;
const FETCH_MULTIPLIER = 3;
const SEND_GAP_MS = 350;

export type BackfillResult = {
  loaded: number;
  skipped: number;
  failed: number;
  total: number;
  emptyHint?: string;
};

/**
 * Nạp N tin gần nhất từ Zalo group vào topic (cũ → mới).
 * Dedup theo message_links (đã gửi TG thật).
 */
export async function backfillGroupHistory(
  api: Api,
  adapter: PersonalAccountAdapter,
  topic: TelegramTopic,
  limit = GROUP_HISTORY_DEFAULT_LIMIT,
): Promise<BackfillResult> {
  if (topic.threadKind !== 'group') {
    return { loaded: 0, skipped: 0, failed: 0, total: 0 };
  }

  const chatId = topic.telegramChatId;
  const topicId = topic.telegramTopicId;

  await api
    .sendMessage(chatId, `📜 Đang nạp tối đa ${limit} tin gần nhất từ group Zalo…`, {
      message_thread_id: topicId,
    })
    .catch(() => undefined);

  let fetchResult;
  try {
    fetchResult = await adapter.fetchGroupHistory(
      topic.sourceGroupId,
      Math.min(200, limit * FETCH_MULTIPLIER),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await api
      .sendMessage(chatId, `⚠️ Không lấy được lịch sử Zalo: ${detail}`, {
        message_thread_id: topicId,
      })
      .catch(() => undefined);
    throw err;
  }

  const msgs = fetchResult.messages;
  const meta = fetchResult.meta;

  if (msgs.length === 0) {
    const hint = meta.isFiltered
      ? 'Zalo đang lọc lịch sử group này với session hiện tại (isFiltered). Thử mở group trên Zalo PC/Web rồi /history lại.'
      : 'Cloud trống. Mở group trên Zalo PC/Web một lần rồi /history lại.';
    await api
      .sendMessage(chatId, `⚠️ ${hint}`, { message_thread_id: topicId })
      .catch(() => undefined);
    return { loaded: 0, skipped: 0, failed: 0, total: 0, emptyHint: hint };
  }

  let loaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const msg of msgs) {
    if (loaded >= limit) break;

    if (msg.messageId) {
      const already = findMessageLinkByZalo(topic.tenantId, msg.messageId);
      if (already) {
        skipped += 1;
        continue;
      }
    }

    try {
      const tgMsgId = await sendPayloadToTelegramTopic({
        topicId,
        chatId,
        text: msg.text,
        styles: msg.styles,
        images: msg.images.length ? msg.images : undefined,
        senderName: msg.isSelf ? undefined : msg.senderName,
        isSelf: msg.isSelf,
      });

      if (tgMsgId != null && msg.messageId) {
        upsertMessageLink({
          tenantId: topic.tenantId,
          direction: 'z2t',
          zaloMsgId: msg.messageId,
          zaloUidFrom: msg.senderId,
          zaloThreadId: topic.sourceGroupId,
          threadKind: 'group',
          telegramChatId: chatId,
          telegramMessageId: tgMsgId,
          telegramTopicId: topicId,
          bodyText: msg.text,
        });
        claimProcessedMessage(topic.tenantId, msg.messageId);
      }
      loaded += 1;
      await sleep(SEND_GAP_MS);
    } catch (err) {
      failed += 1;
      logger.warn(
        { err, messageId: msg.messageId, topicId },
        'Failed to backfill one history message',
      );
    }
  }

  const summary =
    loaded === 0 && skipped > 0
      ? `ℹ️ Không có tin mới: ${skipped}/${msgs.length} tin đã có trên topic này.`
      : `✅ Đã nạp lịch sử: ${loaded} tin mới` +
        (skipped ? `, đã có sẵn ${skipped}` : '') +
        (failed ? `, lỗi ${failed}` : '') +
        ` (quét ${msgs.length} tin, ${meta.pages} trang)`;

  await api
    .sendMessage(chatId, summary, { message_thread_id: topicId })
    .catch(() => undefined);

  logger.info(
    {
      groupId: topic.sourceGroupId,
      topicId,
      loaded,
      skipped,
      failed,
      total: msgs.length,
      pages: meta.pages,
    },
    'Group history backfill done',
  );

  return { loaded, skipped, failed, total: msgs.length };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
