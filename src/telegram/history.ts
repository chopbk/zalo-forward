import type { Api } from 'grammy';
import logger from '../config/logger.js';
import { claimProcessedMessage } from '../db/processed.js';
import {
  findMessageLinkByZalo,
  upsertMessageLink,
} from '../db/message-links.js';
import type { TelegramTopic } from '../db/telegram-topics.js';
import type { PersonalAccountAdapter } from '../personal/adapter.js';
import { sendPayloadToTelegramTopic } from './send.js';

export const GROUP_HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_DEFAULT_LIMIT = GROUP_HISTORY_DEFAULT_LIMIT;
const FETCH_MULTIPLIER = 3;
const SEND_GAP_MS = 350;

export type BackfillResult = {
  loaded: number;
  skipped: number;
  failed: number;
  total: number;
  emptyHint?: string;
};

/** Alias cũ — dùng backfillTopicHistory. */
export async function backfillGroupHistory(
  api: Api,
  adapter: PersonalAccountAdapter,
  topic: TelegramTopic,
  limit = HISTORY_DEFAULT_LIMIT,
): Promise<BackfillResult> {
  return backfillTopicHistory(api, adapter, topic, limit);
}

/**
 * Nạp N tin gần nhất từ Zalo (group hoặc 1-1) vào topic (cũ → mới).
 * Dedup theo message_links.
 */
export async function backfillTopicHistory(
  api: Api,
  adapter: PersonalAccountAdapter,
  topic: TelegramTopic,
  limit = HISTORY_DEFAULT_LIMIT,
): Promise<BackfillResult> {
  const chatId = topic.telegramChatId;
  const topicId = topic.telegramTopicId;
  const kindLabel = topic.threadKind === 'user' ? 'chat 1-1' : 'group';

  await api
    .sendMessage(
      chatId,
      `📜 Đang nạp tối đa ${limit} tin gần nhất từ ${kindLabel} Zalo…`,
      { message_thread_id: topicId },
    )
    .catch(() => undefined);

  let fetchResult;
  try {
    fetchResult = await adapter.fetchThreadHistory(
      topic.sourceGroupId,
      topic.threadKind,
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
    const hint =
      topic.threadKind === 'user'
        ? 'Không lấy được tin 1-1 cũ (WS chỉ giữ khoảng ~2 tuần). Mở chat trên Zalo rồi /history lại.'
        : meta.isFiltered
          ? 'Zalo đang lọc lịch sử group này (isFiltered). Mở group trên Zalo PC/Web rồi /history lại.'
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
        senderName:
          topic.threadKind === 'user' || msg.isSelf
            ? undefined
            : msg.senderName,
        isSelf: msg.isSelf,
      });

      if (tgMsgId != null && msg.messageId) {
        upsertMessageLink({
          tenantId: topic.tenantId,
          direction: 'z2t',
          zaloMsgId: msg.messageId,
          zaloUidFrom: msg.senderId,
          zaloThreadId: topic.sourceGroupId,
          threadKind: topic.threadKind,
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

  const sourceLabel =
    meta.source === 'ws_old' ? 'WS old_messages' : meta.source;
  const summary =
    loaded === 0 && skipped > 0
      ? `ℹ️ Không có tin mới: ${skipped}/${msgs.length} tin đã có trên topic này.`
      : `✅ Đã nạp lịch sử ${kindLabel}: ${loaded} tin mới` +
        (skipped ? `, đã có sẵn ${skipped}` : '') +
        (failed ? `, lỗi ${failed}` : '') +
        ` (quét ${msgs.length} tin · ${sourceLabel}, ${meta.pages} trang)`;

  await api
    .sendMessage(chatId, summary, { message_thread_id: topicId })
    .catch(() => undefined);

  logger.info(
    {
      threadId: topic.sourceGroupId,
      threadKind: topic.threadKind,
      topicId,
      loaded,
      skipped,
      failed,
      total: msgs.length,
      pages: meta.pages,
      source: meta.source,
    },
    'Topic history backfill done',
  );

  return { loaded, skipped, failed, total: msgs.length };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
