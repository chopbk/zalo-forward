import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import {
  canReplyFromTopic,
  findTopicById,
} from '../db/telegram-topics.js';
import { canRelay, findTenantById, getSession } from '../db/tenants.js';
import {
  findMessageLinkByTelegram,
  upsertMessageLink,
} from '../db/message-links.js';
import { sessionManager } from '../personal/manager.js';
import {
  telegramEntitiesToZaloStyles,
  type TelegramEntityLike,
} from './format.js';
import { downloadUrlToBuffer } from './media.js';
import { getTelegramApi } from './client.js';

/**
 * Luồng B: admin nhắn trong topic → group/user Zalo nguồn.
 */
export async function forwardTopicReplyToZalo(input: {
  topicId: number;
  text?: string;
  entities?: TelegramEntityLike[];
  photoFileIds?: string[];
  caption?: string;
  captionEntities?: TelegramEntityLike[];
  telegramMessageId?: number;
  /** Reply vào tin TG đã bridge → quote tin Zalo tương ứng */
  replyToTelegramMessageId?: number;
}): Promise<void> {
  const topic = findTopicById(input.topicId);
  if (!topic) {
    logger.debug({ topicId: input.topicId }, 'Topic reply — unknown topic');
    return;
  }
  if (!canReplyFromTopic(topic)) {
    logger.info(
      { topicId: input.topicId, inboundOnly: topic.inboundOnly },
      'Topic reply skipped (inbound_only or missing)',
    );
    return;
  }

  const tenant = findTenantById(topic.tenantId);
  const session = getSession(topic.tenantId);
  if (!tenant || !canRelay(tenant, session)) {
    throw new Error(`Tenant #${topic.tenantId} không relay được`);
  }

  const adapter = sessionManager.getAdapter(topic.tenantId);
  if (!adapter) {
    throw new Error(`Session tenant #${topic.tenantId} chưa chạy`);
  }

  let quote: import('zca-js').SendMessageQuote | undefined;
  if (input.replyToTelegramMessageId != null) {
    const link = findMessageLinkByTelegram(
      topic.tenantId,
      topic.telegramChatId,
      input.replyToTelegramMessageId,
    );
    if (link?.zaloMsgId && link.zaloCliMsgId) {
      quote = {
        content: link.bodyText ?? '',
        msgType: 'webchat',
        propertyExt: { type: 0, color: 0, size: 0, subType: 0, ext: '{}' },
        uidFrom: link.zaloUidFrom ?? '',
        msgId: link.zaloMsgId,
        cliMsgId: link.zaloCliMsgId,
        ts: String(Date.now()),
        ttl: 0,
      };
    }
  }

  if (input.photoFileIds && input.photoFileIds.length > 0) {
    const api = getTelegramApi();
    const token = getEnv().TELEGRAM_BOT_TOKEN;
    if (!api || !token) throw new Error('Telegram chưa bật');
    const images: Array<{ url: string }> = [];
    for (const fileId of input.photoFileIds) {
      const file = await api.getFile(fileId);
      if (!file.file_path) continue;
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      await downloadUrlToBuffer(url);
      images.push({ url });
    }
    if (images.length === 0) {
      throw new Error('Không lấy được file ảnh từ Telegram');
    }
    const result = await adapter.sendImages(
      topic.sourceGroupId,
      images,
      input.caption ?? '',
      { threadKind: topic.threadKind },
    );
    if (input.telegramMessageId != null && result.messageId) {
      try {
        upsertMessageLink({
          tenantId: topic.tenantId,
          direction: 't2z',
          zaloMsgId: result.messageId,
          zaloThreadId: topic.sourceGroupId,
          threadKind: topic.threadKind,
          telegramChatId: topic.telegramChatId,
          telegramMessageId: input.telegramMessageId,
          telegramTopicId: topic.telegramTopicId,
          bodyText: input.caption ?? '[image]',
        });
      } catch (err) {
        logger.warn({ err }, 'upsertMessageLink t2z photo failed');
      }
    }
    logger.info(
      {
        topicId: input.topicId,
        threadId: topic.sourceGroupId,
        threadKind: topic.threadKind,
        photos: images.length,
      },
      'Forwarded Telegram photos → Zalo',
    );
    return;
  }

  const text = (input.text ?? '').trim();
  if (!text) return;

  const styles = telegramEntitiesToZaloStyles(text, input.entities);
  const result = await adapter.sendText(topic.sourceGroupId, text, {
    styles: styles.length ? styles : undefined,
    threadKind: topic.threadKind,
    quote,
  });

  if (input.telegramMessageId != null && result.messageId) {
    try {
      upsertMessageLink({
        tenantId: topic.tenantId,
        direction: 't2z',
        zaloMsgId: result.messageId,
        zaloCliMsgId: result.cliMsgId,
        zaloThreadId: topic.sourceGroupId,
        threadKind: topic.threadKind,
        telegramChatId: topic.telegramChatId,
        telegramMessageId: input.telegramMessageId,
        telegramTopicId: topic.telegramTopicId,
        bodyText: text,
      });
    } catch (err) {
      logger.warn({ err }, 'upsertMessageLink t2z failed');
    }
  }

  logger.info(
    {
      topicId: input.topicId,
      threadId: topic.sourceGroupId,
      threadKind: topic.threadKind,
      quoted: !!quote,
    },
    'Forwarded Telegram topic → Zalo',
  );
}
