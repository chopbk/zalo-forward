import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import {
  canReplyFromTopic,
  findTopicById,
} from '../db/telegram-topics.js';
import { canRelay, findTenantById, getSession } from '../db/tenants.js';
import { sessionManager } from '../personal/manager.js';
import {
  telegramEntitiesToZaloStyles,
  type TelegramEntityLike,
} from './format.js';
import { downloadUrlToBuffer } from './media.js';
import { getTelegramApi } from './client.js';

/**
 * Luồng B: admin nhắn trong topic → group Zalo nguồn.
 */
export async function forwardTopicReplyToZalo(input: {
  topicId: number;
  text?: string;
  entities?: TelegramEntityLike[];
  photoFileIds?: string[];
  caption?: string;
  captionEntities?: TelegramEntityLike[];
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

  if (input.photoFileIds && input.photoFileIds.length > 0) {
    const api = getTelegramApi();
    const token = getEnv().TELEGRAM_BOT_TOKEN;
    if (!api || !token) throw new Error('Telegram chưa bật');
    const images: Array<{ url: string }> = [];
    for (const fileId of input.photoFileIds) {
      const file = await api.getFile(fileId);
      if (!file.file_path) continue;
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      // Probe tải được trước khi giao URL cho zca-js
      await downloadUrlToBuffer(url);
      images.push({ url });
    }
    if (images.length === 0) {
      throw new Error('Không lấy được file ảnh từ Telegram');
    }
    await adapter.sendImages(topic.sourceGroupId, images, input.caption ?? '');
    logger.info(
      { topicId: input.topicId, groupId: topic.sourceGroupId, photos: images.length },
      'Forwarded Telegram photos → Zalo group',
    );
    return;
  }

  const text = (input.text ?? '').trim();
  if (!text) return;

  const styles = telegramEntitiesToZaloStyles(text, input.entities);
  await adapter.sendText(topic.sourceGroupId, text, {
    styles: styles.length ? styles : undefined,
  });
  logger.info(
    { topicId: input.topicId, groupId: topic.sourceGroupId },
    'Forwarded Telegram topic → Zalo group',
  );
}
