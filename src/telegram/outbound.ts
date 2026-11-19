import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import {
  canReplyFromTopic,
  findTopicById,
  isDmInboxTopic,
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
 * DM Inbox: chỉ gửi khi reply đúng tin đã bridge (lấy zalo_thread_id từ link).
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

  const inbox = isDmInboxTopic(topic);
  if (!inbox && !canReplyFromTopic(topic)) {
    logger.info(
      { topicId: input.topicId, inboundOnly: topic.inboundOnly },
      'Topic reply skipped (inbound_only or missing)',
    );
    return;
  }
  if (topic.topicMissing) {
    logger.info({ topicId: input.topicId }, 'Topic reply skipped (missing)');
    return;
  }

  let replyLink =
    input.replyToTelegramMessageId != null
      ? findMessageLinkByTelegram(
          topic.tenantId,
          topic.telegramChatId,
          input.replyToTelegramMessageId,
        )
      : null;

  // Inbox: bắt buộc reply tin đã bridge để biết gửi cho ai
  let targetThreadId = topic.sourceGroupId;
  if (inbox) {
    if (!replyLink?.zaloThreadId || replyLink.zaloThreadId.startsWith('__')) {
      logger.info(
        { topicId: input.topicId },
        'DM Inbox reply skipped — reply vào tin đã bridge để chọn người nhận',
      );
      return;
    }
    targetThreadId = replyLink.zaloThreadId;
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
  if (replyLink?.zaloMsgId && replyLink.zaloCliMsgId) {
    quote = {
      content: replyLink.bodyText ?? '',
      msgType: 'webchat',
      propertyExt: { type: 0, color: 0, size: 0, subType: 0, ext: '{}' },
      uidFrom: replyLink.zaloUidFrom ?? '',
      msgId: replyLink.zaloMsgId,
      cliMsgId: replyLink.zaloCliMsgId,
      ts: String(Date.now()),
      ttl: 0,
    };
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
    const kind = inbox ? 'user' : topic.threadKind;
    const result = await adapter.sendImages(
      targetThreadId,
      images,
      input.caption ?? '',
      { threadKind: kind },
    );
    if (input.telegramMessageId != null && result.messageId) {
      try {
        upsertMessageLink({
          tenantId: topic.tenantId,
          direction: 't2z',
          zaloMsgId: result.messageId,
          zaloThreadId: targetThreadId,
          threadKind: kind,
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
        threadId: targetThreadId,
        threadKind: kind,
        photos: images.length,
        inbox,
      },
      'Forwarded Telegram photos → Zalo',
    );
    return;
  }

  const text = (input.text ?? '').trim();
  if (!text) return;

  const styles = telegramEntitiesToZaloStyles(text, input.entities);
  const result = await adapter.sendText(targetThreadId, text, {
    styles: styles.length ? styles : undefined,
    threadKind: inbox ? 'user' : topic.threadKind,
    quote,
  });

  if (input.telegramMessageId != null && result.messageId) {
    try {
      upsertMessageLink({
        tenantId: topic.tenantId,
        direction: 't2z',
        zaloMsgId: result.messageId,
        zaloCliMsgId: result.cliMsgId,
        zaloThreadId: targetThreadId,
        threadKind: inbox ? 'user' : topic.threadKind,
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
      threadId: targetThreadId,
      threadKind: inbox ? 'user' : topic.threadKind,
      quoted: !!quote,
      inbox,
    },
    'Forwarded Telegram topic → Zalo',
  );
}
