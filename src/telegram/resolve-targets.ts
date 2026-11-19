import {
  listRulesForSource,
  upsertRuleBySource,
  updateRule,
  getRule,
  type ForwardRule,
} from '../db/rules.js';
import { isTelegramDest } from './dest.js';
import { ensureTelegramTopicForSource } from './topics.js';
import { setInboundOnly } from '../db/telegram-topics.js';
import { parseTelegramDest } from './dest.js';

/**
 * Resolve targets: tạo topic nếu wantsTelegram, merge dest tg:# vào danh sách.
 * Giữ các tg:# cũ cùng nguồn nếu không muốn tạo mới (wantsTelegram=false nhưng targets đã có tg).
 */
export async function resolveTargetsWithTelegram(input: {
  tenantId: number;
  sourceGroupId: string;
  zaloTargets: string[];
  wantsTelegram: boolean;
  inboundOnly?: boolean;
  /** Khi set rule theo id — dùng rule hiện có để merge tg cũ nếu không tạo mới */
  existingTargets?: string[];
}): Promise<string[]> {
  const base = [
    ...new Set(
      [
        ...input.zaloTargets,
        ...(input.existingTargets ?? []).filter((t) => isTelegramDest(t)),
      ].filter(Boolean),
    ),
  ].filter((t) => t !== input.sourceGroupId);

  if (!input.wantsTelegram) {
    return base;
  }

  const { destKey, topic } = await ensureTelegramTopicForSource({
    tenantId: input.tenantId,
    sourceGroupId: input.sourceGroupId,
    inboundOnly: input.inboundOnly,
  });

  if (input.inboundOnly != null) {
    setInboundOnly(topic.telegramTopicId, input.inboundOnly);
  }

  // Bỏ tg:# cũ khác topic (cùng nguồn chỉ 1 topic / forum)
  const withoutOldTg = base.filter((t) => !isTelegramDest(t));
  return [...withoutOldTg, destKey];
}

export async function upsertRuleWithTelegram(input: {
  tenantId: number;
  sourceGroupId: string;
  zaloTargets: string[];
  wantsTelegram: boolean;
  filterMode: 'all' | 'keywords';
  keywords?: string[];
  inboundOnly?: boolean;
  /**
   * true (/addtg): giữ đích Zalo cũ của luật nguồn, chỉ thêm/cập nhật tg.
   * false (/addrule): thay toàn bộ đích bằng danh sách mới (+ tg nếu có).
   */
  mergeExistingZalo?: boolean;
}): Promise<{ rule: ForwardRule; created: boolean; removedIds: number[]; tgDest?: string }> {
  const existing = listRulesForSource(input.tenantId, input.sourceGroupId);
  const existingTargets = existing[0]?.targets ?? [];
  const existingZalo = existingTargets.filter((t) => !isTelegramDest(t));

  const zaloTargets = input.mergeExistingZalo
    ? [...new Set([...existingZalo, ...input.zaloTargets])]
    : input.zaloTargets;

  const targets = await resolveTargetsWithTelegram({
    tenantId: input.tenantId,
    sourceGroupId: input.sourceGroupId,
    zaloTargets,
    wantsTelegram: input.wantsTelegram,
    inboundOnly: input.inboundOnly,
    existingTargets: [],
  });

  if (targets.length === 0) {
    throw new Error('Cần ít nhất 1 đích (Zalo group hoặc tg)');
  }

  const result = upsertRuleBySource({
    tenantId: input.tenantId,
    sourceGroupId: input.sourceGroupId,
    targets,
    filterMode: input.filterMode,
    keywords: input.keywords,
  });

  const tgDest = targets.find((t) => isTelegramDest(t));
  if (tgDest) {
    const topicId = parseTelegramDest(tgDest);
    if (topicId != null) {
      const { updateTopicRuleId } = await import('../db/telegram-topics.js');
      updateTopicRuleId(topicId, result.rule.id);
    }
  }

  return { ...result, tgDest };
}

export async function updateRuleWithTelegram(input: {
  ruleId: number;
  tenantId: number;
  sourceGroupId: string;
  zaloTargets: string[];
  wantsTelegram: boolean;
  filterMode: 'all' | 'keywords';
  keywords?: string[];
}): Promise<ForwardRule | null> {
  const existing = getRule(input.ruleId);
  if (!existing) return null;

  const targets = await resolveTargetsWithTelegram({
    tenantId: input.tenantId,
    sourceGroupId: input.sourceGroupId,
    zaloTargets: input.zaloTargets,
    wantsTelegram: input.wantsTelegram,
    existingTargets: input.wantsTelegram ? [] : existing.targets,
  });

  const updated = updateRule(input.ruleId, {
    targets,
    filterMode: input.filterMode,
    keywords: input.keywords,
  });

  const tgDest = targets.find((t) => isTelegramDest(t));
  if (tgDest) {
    const topicId = parseTelegramDest(tgDest);
    if (topicId != null) {
      const { updateTopicRuleId } = await import('../db/telegram-topics.js');
      updateTopicRuleId(topicId, input.ruleId);
    }
  }

  return updated;
}
