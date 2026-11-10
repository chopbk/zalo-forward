import {
  clearConversation,
  getConversation,
  setConversation,
  type Conversation,
} from '../db/conversations.js';
import {
  addKeywords,
  createRule,
  getGroupName,
  listRules,
} from '../db/rules.js';
import { detectSimpleCycles } from '../relay/match.js';
import type { Tenant } from '../db/tenants.js';
import type { ZaloBotControl } from './adapter.js';

export async function handleConversationReply(
  bot: ZaloBotControl,
  tenant: Tenant,
  text: string,
  conv: Conversation,
): Promise<boolean> {
  const raw = text.trim();
  if (raw === '/cancel' || raw.toLowerCase() === 'hủy' || raw.toLowerCase() === 'huy') {
    clearConversation(tenant.zaloBotUserId);
    await bot.sendText(tenant.zaloBotUserId, 'Đã hủy. Gõ /help để xem lệnh.');
    return true;
  }

  switch (conv.state) {
    case 'addrule_source': {
      const source = raw.split(/[\s,;]+/)[0]!;
      setConversation(tenant.zaloBotUserId, 'addrule_targets', { sourceGroupId: source });
      const name = getGroupName(tenant.id, source);
      await bot.sendText(
        tenant.zaloBotUserId,
        `Nguồn: ${name ? `${name} (${source})` : source}\n` +
          `Gửi id group đích (nhiều id cách nhau dấu phẩy).\n` +
          `Xem /groups. Gõ /cancel để hủy.`,
      );
      return true;
    }
    case 'addrule_targets': {
      const sourceGroupId = String(conv.data.sourceGroupId ?? '');
      const targets = raw
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (targets.length === 0) {
        await bot.sendText(tenant.zaloBotUserId, 'Cần ít nhất 1 group đích.');
        return true;
      }
      setConversation(tenant.zaloBotUserId, 'addrule_filter', {
        sourceGroupId,
        targets,
      });
      await bot.sendText(
        tenant.zaloBotUserId,
        'Chọn lọc tin:\n1 — tất cả tin\n2 — theo từ khóa\n\nTrả lời 1 hoặc 2.',
      );
      return true;
    }
    case 'addrule_filter': {
      const choice = raw[0];
      if (choice === '1') {
        setConversation(tenant.zaloBotUserId, 'addrule_confirm', {
          ...conv.data,
          filterMode: 'all',
          keywords: [],
        });
        await sendConfirm(bot, tenant, {
          sourceGroupId: String(conv.data.sourceGroupId),
          targets: (conv.data.targets as string[]) ?? [],
          filterMode: 'all',
          keywords: [],
        });
        return true;
      }
      if (choice === '2') {
        setConversation(tenant.zaloBotUserId, 'addrule_keywords', { ...conv.data });
        await bot.sendText(
          tenant.zaloBotUserId,
          'Gửi từ khóa, cách nhau dấu phẩy (ví dụ: sale, giảm giá, hot).',
        );
        return true;
      }
      await bot.sendText(tenant.zaloBotUserId, 'Chỉ trả lời 1 hoặc 2.');
      return true;
    }
    case 'addrule_keywords': {
      const keywords = raw
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (keywords.length === 0) {
        await bot.sendText(tenant.zaloBotUserId, 'Cần ít nhất 1 từ khóa.');
        return true;
      }
      setConversation(tenant.zaloBotUserId, 'addrule_confirm', {
        ...conv.data,
        filterMode: 'keywords',
        keywords,
      });
      await sendConfirm(bot, tenant, {
        sourceGroupId: String(conv.data.sourceGroupId),
        targets: (conv.data.targets as string[]) ?? [],
        filterMode: 'keywords',
        keywords,
      });
      return true;
    }
    case 'addrule_confirm': {
      const lower = raw.toLowerCase();
      if (lower === 'ok' || lower === 'yes' || lower === 'y' || lower === 'có' || lower === 'co') {
        try {
          const rule = createRule({
            tenantId: tenant.id,
            sourceGroupId: String(conv.data.sourceGroupId),
            targets: (conv.data.targets as string[]) ?? [],
            filterMode: conv.data.filterMode === 'keywords' ? 'keywords' : 'all',
            keywords: (conv.data.keywords as string[]) ?? [],
          });
          clearConversation(tenant.zaloBotUserId);
          const cycles = detectSimpleCycles(
            listRules(tenant.id).map((r) => ({
              sourceGroupId: r.sourceGroupId,
              targets: r.targets,
            })),
          );
          let msg = `Đã tạo luật #${rule.id}.\nNguồn ${rule.sourceGroupId} → ${rule.targets.join(', ')}\nLọc: ${rule.filterMode}`;
          if (cycles.length) {
            msg += `\n⚠️ Cảnh báo vòng lặp: ${cycles.join('; ')}`;
          }
          await bot.sendText(tenant.zaloBotUserId, msg);
        } catch (err) {
          await bot.sendText(
            tenant.zaloBotUserId,
            `Lỗi: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return true;
      }
      if (lower === 'no' || lower === 'n' || lower === 'không' || lower === 'khong') {
        clearConversation(tenant.zaloBotUserId);
        await bot.sendText(tenant.zaloBotUserId, 'Đã hủy tạo luật.');
        return true;
      }
      await bot.sendText(tenant.zaloBotUserId, 'Trả lời ok hoặc không.');
      return true;
    }
    case 'keywords_rule_id': {
      const ruleId = Number(raw);
      if (!Number.isFinite(ruleId)) {
        await bot.sendText(tenant.zaloBotUserId, 'Gửi số id luật (xem /rules).');
        return true;
      }
      const rule = listRules(tenant.id).find((r) => r.id === ruleId);
      if (!rule) {
        await bot.sendText(tenant.zaloBotUserId, 'Không tìm thấy luật.');
        return true;
      }
      setConversation(tenant.zaloBotUserId, 'keywords_add', { ruleId });
      await bot.sendText(
        tenant.zaloBotUserId,
        `Luật #${ruleId} — từ khóa hiện có: ${rule.keywords.join(', ') || '(trống)'}\n` +
          `Gửi từ khóa mới (cách nhau dấu phẩy).`,
      );
      return true;
    }
    case 'keywords_add': {
      const ruleId = Number(conv.data.ruleId);
      const kws = raw
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const updated = addKeywords(ruleId, kws);
      clearConversation(tenant.zaloBotUserId);
      if (!updated || updated.tenantId !== tenant.id) {
        await bot.sendText(tenant.zaloBotUserId, 'Không cập nhật được.');
        return true;
      }
      await bot.sendText(
        tenant.zaloBotUserId,
        `Đã cập nhật keywords luật #${ruleId}: ${updated.keywords.join(', ')}`,
      );
      return true;
    }
    default:
      return false;
  }
}

async function sendConfirm(
  bot: ZaloBotControl,
  tenant: Tenant,
  draft: {
    sourceGroupId: string;
    targets: string[];
    filterMode: string;
    keywords: string[];
  },
): Promise<void> {
  const srcName = getGroupName(tenant.id, draft.sourceGroupId);
  const lines = [
    'Xác nhận tạo luật:',
    `Nguồn: ${srcName ?? draft.sourceGroupId} (${draft.sourceGroupId})`,
    `Đích: ${draft.targets.join(', ')}`,
    `Lọc: ${draft.filterMode}${
      draft.filterMode === 'keywords' ? ` [${draft.keywords.join(', ')}]` : ''
    }`,
    '',
    'Trả lời ok để lưu, không để hủy.',
  ];
  await bot.sendText(tenant.zaloBotUserId, lines.join('\n'));
}

export function startAddRuleFlow(zaloBotUserId: string): void {
  setConversation(zaloBotUserId, 'addrule_source', {});
}

export function startKeywordsFlow(zaloBotUserId: string): void {
  setConversation(zaloBotUserId, 'keywords_rule_id', {});
}

export { getConversation, clearConversation };
