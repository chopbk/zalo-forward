import { getDb } from './client.js';

export type ThreadKind = 'user' | 'group';

export type TelegramTopic = {
  telegramTopicId: number;
  tenantId: number;
  ruleId: number | null;
  sourceGroupId: string;
  telegramChatId: string;
  topicTitle: string | null;
  inboundOnly: boolean;
  topicMissing: boolean;
  threadKind: ThreadKind;
  createdAt: string;
};

type Row = {
  telegram_topic_id: number;
  tenant_id: number;
  rule_id: number | null;
  source_group_id: string;
  telegram_chat_id: string;
  topic_title: string | null;
  inbound_only: number;
  topic_missing: number;
  thread_kind?: string | null;
  created_at: string;
};

function mapRow(row: Row): TelegramTopic {
  return {
    telegramTopicId: row.telegram_topic_id,
    tenantId: row.tenant_id,
    ruleId: row.rule_id,
    sourceGroupId: row.source_group_id,
    telegramChatId: row.telegram_chat_id,
    topicTitle: row.topic_title,
    inboundOnly: row.inbound_only === 1,
    topicMissing: row.topic_missing === 1,
    threadKind: row.thread_kind === 'user' ? 'user' : 'group',
    createdAt: row.created_at,
  };
}

export function findTopicById(topicId: number): TelegramTopic | null {
  const row = getDb()
    .prepare(`SELECT * FROM telegram_topics WHERE telegram_topic_id = ?`)
    .get(topicId) as Row | undefined;
  return row ? mapRow(row) : null;
}

export function findTopicBySource(
  tenantId: number,
  sourceGroupId: string,
  chatId: string,
): TelegramTopic | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM telegram_topics
       WHERE tenant_id = ? AND source_group_id = ? AND telegram_chat_id = ?`,
    )
    .get(tenantId, sourceGroupId, chatId) as Row | undefined;
  return row ? mapRow(row) : null;
}

export function insertTelegramTopic(input: {
  telegramTopicId: number;
  tenantId: number;
  ruleId: number | null;
  sourceGroupId: string;
  telegramChatId: string;
  topicTitle?: string | null;
  inboundOnly?: boolean;
  threadKind?: ThreadKind;
}): TelegramTopic {
  getDb()
    .prepare(
      `INSERT INTO telegram_topics (
         telegram_topic_id, tenant_id, rule_id, source_group_id,
         telegram_chat_id, topic_title, inbound_only, thread_kind
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.telegramTopicId,
      input.tenantId,
      input.ruleId,
      input.sourceGroupId,
      input.telegramChatId,
      input.topicTitle ?? null,
      (input.inboundOnly ?? true) ? 1 : 0,
      input.threadKind === 'user' ? 'user' : 'group',
    );
  return findTopicById(input.telegramTopicId)!;
}

export function setThreadKind(topicId: number, threadKind: ThreadKind): void {
  getDb()
    .prepare(`UPDATE telegram_topics SET thread_kind = ? WHERE telegram_topic_id = ?`)
    .run(threadKind === 'user' ? 'user' : 'group', topicId);
}

export function updateTopicRuleId(topicId: number, ruleId: number): void {
  getDb()
    .prepare(`UPDATE telegram_topics SET rule_id = ? WHERE telegram_topic_id = ?`)
    .run(ruleId, topicId);
}

export function updateTopicId(
  oldTopicId: number,
  newTopicId: number,
  title?: string | null,
): TelegramTopic | null {
  getDb()
    .prepare(
      `UPDATE telegram_topics
       SET telegram_topic_id = ?,
           topic_title = COALESCE(?, topic_title),
           topic_missing = 0
       WHERE telegram_topic_id = ?`,
    )
    .run(newTopicId, title ?? null, oldTopicId);
  return findTopicById(newTopicId);
}

export function setTopicMissing(topicId: number, missing: boolean): void {
  getDb()
    .prepare(`UPDATE telegram_topics SET topic_missing = ? WHERE telegram_topic_id = ?`)
    .run(missing ? 1 : 0, topicId);
}

export function setInboundOnly(topicId: number, inboundOnly: boolean): void {
  getDb()
    .prepare(`UPDATE telegram_topics SET inbound_only = ? WHERE telegram_topic_id = ?`)
    .run(inboundOnly ? 1 : 0, topicId);
}

export function deleteTelegramTopic(topicId: number): boolean {
  const info = getDb()
    .prepare(`DELETE FROM telegram_topics WHERE telegram_topic_id = ?`)
    .run(topicId);
  return info.changes > 0;
}

export function listTopicsByTenant(tenantId: number): TelegramTopic[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM telegram_topics WHERE tenant_id = ? ORDER BY telegram_topic_id ASC`,
    )
    .all(tenantId) as Row[];
  return rows.map(mapRow);
}

/** Topic còn nhận reply từ Telegram admin → Zalo. */
export function canReplyFromTopic(topic: TelegramTopic): boolean {
  return !topic.inboundOnly && !topic.topicMissing;
}
