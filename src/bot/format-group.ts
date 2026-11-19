import { getGroupName } from '../db/rules.js';
import { findTopicById } from '../db/telegram-topics.js';
import { isTelegramDest, parseTelegramDest } from '../telegram/dest.js';

/** Hiển thị "Tên (id)" — thiếu tên thì chỉ id. Telegram: tg:#topic. */
export function formatGroupLabel(tenantId: number, groupId: string): string {
  if (isTelegramDest(groupId)) {
    const topicId = parseTelegramDest(groupId);
    const topic = topicId != null ? findTopicById(topicId) : null;
    const title = topic?.topicTitle?.trim();
    if (title) return `TG · ${title} (${groupId})`;
    return `Telegram ${groupId}`;
  }
  const name = getGroupName(tenantId, groupId)?.trim();
  if (!name || name === groupId) return groupId;
  return `${name} (${groupId})`;
}

export function formatGroupList(tenantId: number, groupIds: string[]): string {
  return groupIds.map((id) => formatGroupLabel(tenantId, id)).join(', ');
}
