import type { Api } from 'grammy';
import logger from '../config/logger.js';
import {
  findTopicById,
  findTopicBySource,
  insertTelegramTopic,
  setTopicMissing,
  updateTopicId,
  updateTopicRuleId,
  type TelegramTopic,
} from '../db/telegram-topics.js';
import { getGroupName } from '../db/rules.js';
import { requireTenantForum } from '../db/tenant-telegram.js';
import { getTelegramApi, truncateTopicTitle } from './client.js';
import { telegramDestKey } from './dest.js';
import { isTelegramEnabled } from '../config/env.js';

export async function ensureTelegramTopicForSource(input: {
  tenantId: number;
  sourceGroupId: string;
  ruleId?: number | null;
  inboundOnly?: boolean;
}): Promise<{ topic: TelegramTopic; destKey: string; created: boolean }> {
  if (!isTelegramEnabled()) {
    throw new Error('Telegram chưa bật. Điền TELEGRAM_BOT_TOKEN trong .env');
  }
  const api = getTelegramApi();
  if (!api) {
    throw new Error('Telegram chưa bật. Điền TELEGRAM_BOT_TOKEN trong .env');
  }

  const forum = requireTenantForum(input.tenantId);
  const chatId = forum.forumGroupId;

  const existing = findTopicBySource(input.tenantId, input.sourceGroupId, chatId);
  if (existing) {
    if (existing.topicMissing) {
      const recreated = await recreateTopic(api, existing);
      if (input.ruleId != null) updateTopicRuleId(recreated.telegramTopicId, input.ruleId);
      return {
        topic: recreated,
        destKey: telegramDestKey(recreated.telegramTopicId),
        created: true,
      };
    }
    if (input.ruleId != null && existing.ruleId !== input.ruleId) {
      updateTopicRuleId(existing.telegramTopicId, input.ruleId);
    }
    return {
      topic: existing,
      destKey: telegramDestKey(existing.telegramTopicId),
      created: false,
    };
  }

  const groupName = getGroupName(input.tenantId, input.sourceGroupId);
  const title = truncateTopicTitle(
    `T${input.tenantId} · ${groupName || input.sourceGroupId}`,
  );
  const created = await api.createForumTopic(chatId, title);
  const topicId = created.message_thread_id;

  try {
    const topic = insertTelegramTopic({
      telegramTopicId: topicId,
      tenantId: input.tenantId,
      ruleId: input.ruleId ?? null,
      sourceGroupId: input.sourceGroupId,
      telegramChatId: chatId,
      topicTitle: title,
      inboundOnly: input.inboundOnly ?? false,
    });
    logger.info(
      {
        tenantId: input.tenantId,
        sourceGroupId: input.sourceGroupId,
        topicId,
        title,
        forum: chatId,
      },
      'Created Telegram forum topic',
    );
    return { topic, destKey: telegramDestKey(topicId), created: true };
  } catch (err) {
    try {
      await api.deleteForumTopic(chatId, topicId);
    } catch (delErr) {
      logger.warn({ delErr, topicId }, 'Failed to delete orphan forum topic');
    }
    throw err;
  }
}

async function recreateTopic(api: Api, topic: TelegramTopic): Promise<TelegramTopic> {
  const forumId = topic.telegramChatId;
  const title = truncateTopicTitle(
    topic.topicTitle || `T${topic.tenantId} · ${topic.sourceGroupId}`,
  );
  const created = await api.createForumTopic(forumId, title);
  const newId = created.message_thread_id;
  const updated = updateTopicId(topic.telegramTopicId, newId, title);

  if (topic.ruleId != null) {
    try {
      const { getDb } = await import('../db/client.js');
      getDb()
        .prepare(
          `UPDATE rule_targets SET dest_group_id = ?
           WHERE rule_id = ? AND dest_group_id = ?`,
        )
        .run(telegramDestKey(newId), topic.ruleId, telegramDestKey(topic.telegramTopicId));
    } catch (err) {
      logger.warn({ err, ruleId: topic.ruleId }, 'Failed to rewrite tg dest after recreate');
    }
  }

  logger.info(
    {
      oldTopicId: topic.telegramTopicId,
      newTopicId: newId,
      sourceGroupId: topic.sourceGroupId,
    },
    'Recreated Telegram forum topic',
  );
  return updated ?? { ...topic, telegramTopicId: newId, topicMissing: false };
}

export async function recreateTopicById(topicId: number): Promise<TelegramTopic | null> {
  const api = getTelegramApi();
  if (!api) throw new Error('Telegram chưa bật');
  const topic = findTopicById(topicId);
  if (!topic) return null;
  setTopicMissing(topicId, true);
  return recreateTopic(api, { ...topic, topicMissing: true });
}

export function markTopicMissingFromError(topicId: number, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (/topic.*not found|message thread not found|TOPIC_DELETED/i.test(msg)) {
    setTopicMissing(topicId, true);
    logger.warn({ topicId, msg }, 'Marked telegram topic missing');
  }
}
