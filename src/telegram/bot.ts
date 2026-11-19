import { Bot, type Context } from 'grammy';
import { getEnv, isTelegramEnabled } from '../config/env.js';
import logger from '../config/logger.js';
import {
  findTenantTelegramByForum,
  isForumAdmin,
  type TenantTelegram,
} from '../db/tenant-telegram.js';
import {
  findTopicById,
  listTopicsByTenant,
  setInboundOnly,
  setThreadKind,
  updateTopicTitle,
  deleteTelegramTopic,
} from '../db/telegram-topics.js';
import { getSession } from '../db/tenants.js';
import {
  deleteRule,
  getRule,
  listRules,
  setRuleEnabled,
  upsertGroupCache,
} from '../db/rules.js';
import { formatRelativeTime } from '../personal/adapter.js';
import { sessionManager } from '../personal/manager.js';
import { getTelegramBot, getTelegramApi, verifyTelegramForum } from './client.js';
import { forwardTopicReplyToZalo } from './outbound.js';
import { recreateTopicById } from './topics.js';
import { upsertRuleWithTelegram } from './resolve-targets.js';
import { parseTelegramDest, telegramDestKey } from './dest.js';
import { getDb } from '../db/client.js';
import {
  INBOUND_ONLY_TOKENS,
  TWOWAY_TOKENS,
  parseCommaIds,
  replyChunks,
  takeLeadingIds,
} from './parse-ids.js';
import type { TelegramTopic } from '../db/telegram-topics.js';
import {
  backfillGroupHistory,
  GROUP_HISTORY_DEFAULT_LIMIT,
} from './history.js';
import {
  syncTelegramDeleteToZalo,
  syncTelegramEditToZalo,
} from './sync.js';

let started = false;
const pendingAlbums = new Map<
  string,
  {
    timer: ReturnType<typeof setTimeout>;
    topicId: number;
    fileIds: string[];
    caption?: string;
    captionEntities?: Array<{ type: string; offset: number; length: number }>;
  }
>();

type ForumCtx = {
  cfg: TenantTelegram;
  chatId: string;
};

function resolveForum(ctx: Context): ForumCtx | null {
  const chatId = ctx.chat?.id != null ? String(ctx.chat.id) : '';
  if (!chatId) return null;
  const cfg = findTenantTelegramByForum(chatId);
  if (!cfg || !cfg.enabled) return null;
  return { cfg, chatId };
}

function requireForumAdmin(ctx: Context): ForumCtx | null {
  const forum = resolveForum(ctx);
  if (!forum) return null;
  if (!isForumAdmin(forum.cfg, ctx.from?.id, getEnv().telegramAdminIds)) {
    return null;
  }
  return forum;
}

export async function startTelegramBot(): Promise<void> {
  if (!isTelegramEnabled()) {
    logger.info('Telegram bridge disabled (missing TELEGRAM_BOT_TOKEN)');
    return;
  }
  const bot = getTelegramBot();
  if (!bot || started) return;

  wireHandlers(bot);
  started = true;
  void bot.start({
    onStart: (info) => {
      logger.info({ username: info.username }, 'Telegram bot polling started');
    },
    allowed_updates: ['message', 'edited_message'],
  });
}

export async function stopTelegramBot(): Promise<void> {
  const bot = getTelegramBot();
  if (!bot || !started) return;
  try {
    await bot.stop();
  } catch (err) {
    logger.warn({ err }, 'Telegram bot stop error');
  }
  started = false;
}

function wireHandlers(bot: Bot): void {
  const helpText = [
    'Zalo Message Forward — lệnh trong forum tenant',
    '',
    '/help /tghelp — trợ giúp',
    '/config — kiểm tra bot + forum + session Zalo',
    '/users /list — danh sách map Zalo → topic',
    '/search <từ khóa> — tìm theo tên / id',
    '/useradd <id> [group|user] [twoway] [tên] — mặc định readonly',
    '/useradd <id1>,<id2>,<id3> [group] — thêm nhiều id (readonly)',
    '/useredit <id>[,id…] name=… inbound_only=1 kind=group',
    '/userdel <id|topic> · /userdel <id1>,<id2> — xóa map',
    '/tginfo — chi tiết topic hiện tại',
    '/recreate — tạo lại topic bị xóa',
    '/history — nạp lịch sử group vào topic',
    '/del — reply tin → xoá TG + thu hồi Zalo',
    '/readonly | /twoway — đổi một chiều / hai chiều',
    '/zalochats [user|group] — chat Zalo gần đây',
    '/zalogroups · /zalofriends — chỉ group / chỉ 1-1',
    '',
    'Reply text/ảnh trong topic → gửi Zalo (nếu twoway).',
    'Reply vào tin đã bridge → quote tin Zalo tương ứng.',
    'Gắn forum: trên Zalo bot dùng /tgbind <forum_id>',
  ].join('\n');

  bot.command(['help', 'tghelp', 'start'], async (ctx) => {
    if (ctx.chat?.type === 'private') {
      await ctx.reply(
        [
          'Bot bridge Zalo ↔ Telegram topic.',
          '1) Add bot vào forum (Topics) làm admin',
          '2) /id trong forum → lấy chat id',
          '3) Trên Zalo bot: /tgbind <forum_id> + /tgadmins <your_tg_id>',
          '4) Trong forum: /useradd <zalo_group_id>',
          '',
          helpText,
        ].join('\n'),
      );
      return;
    }
    const forum = requireForumAdmin(ctx);
    if (!forum) return;
    await ctx.reply(helpText);
  });

  bot.command('id', async (ctx) => {
    const lines = [
      `chat.id = ${ctx.chat?.id}`,
      `chat.type = ${ctx.chat?.type}`,
      ctx.chat && 'title' in ctx.chat ? `title = ${ctx.chat.title}` : null,
      ctx.from ? `from.id = ${ctx.from.id}` : null,
      ctx.message?.message_thread_id != null
        ? `topic = ${ctx.message.message_thread_id}`
        : null,
      resolveForum(ctx)
        ? `tenant = #${resolveForum(ctx)!.cfg.tenantId}`
        : 'tenant = (chưa /tgbind)',
    ].filter(Boolean);
    await ctx.reply(lines.join('\n'));
  });

  bot.command(['config', 'settings', 'check', 'status'], async (ctx) => {
    const forum = requireForumAdmin(ctx);
    if (!forum) return;
    const check = await verifyTelegramForum(forum.chatId);
    const session = getSession(forum.cfg.tenantId);
    const topics = listTopicsByTenant(forum.cfg.tenantId);
    await ctx.reply(
      [
        check.ok
          ? `Forum OK (@${check.botUsername ?? '?'}) ${check.title ?? ''}`
          : `Forum lỗi: ${check.error}`,
        `Tenant: #${forum.cfg.tenantId}`,
        `Forum id: ${forum.chatId}`,
        `TG admins: ${forum.cfg.adminIds.join(', ') || '(chỉ TELEGRAM_ADMIN_IDS global)'}`,
        `Zalo session: ${session?.status ?? 'none'}`,
        `Topics: ${topics.length}`,
        `Rules: ${listRules(forum.cfg.tenantId).length}`,
      ].join('\n'),
    );
  });

  bot.command(['users', 'list'], async (ctx) => {
    const forum = requireForumAdmin(ctx);
    if (!forum) return;
    const topics = listTopicsByTenant(forum.cfg.tenantId);
    if (topics.length === 0) {
      await ctx.reply('Chưa có map. /useradd <zalo_group_id>');
      return;
    }
    const lines = topics.map((t) => {
      const flag = t.inboundOnly ? 'RO' : 'RW';
      const miss = t.topicMissing ? ' MISSING' : '';
      return `#${t.telegramTopicId} [${flag}${miss}] ${t.sourceGroupId}` +
        (t.topicTitle ? `\n  ${t.topicTitle}` : '');
    });
    await ctx.reply(lines.join('\n\n'));
  });

  bot.command(['useradd', 'user_add', 'addtg'], async (ctx) => {
    const forum = requireForumAdmin(ctx);
    if (!forum) return;
    const raw = (ctx.message?.text ?? '').replace(/^\/\S+\s*/, '').trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    const { ids, rest } = takeLeadingIds(parts);
    if (ids.length === 0) {
      await ctx.reply(
        [
          'Dùng (giống tg-zalo):',
          '/useradd <zalo_id> [group|user] [twoway] [tên]',
          '/useradd <id1>,<id2>,<id3> [group|user]',
          'Nhiều id cách nhau dấu phẩy.',
          'Mặc định readonly (chỉ Zalo→TG). Thêm twoway để reply ngược.',
          'Không ghi tên → bot thử lấy từ /zalochats cache.',
          'Lưu ý: forward live hiện hỗ trợ nguồn **group** tốt nhất.',
        ].join('\n'),
      );
      return;
    }

    let forceKind: 'user' | 'group' | undefined;
    let inboundOnly = true;
    const nameParts: string[] = [];
    for (const token of rest) {
      const lower = token.toLowerCase();
      if (lower === 'group' || lower === 'user') {
        forceKind = lower;
        continue;
      }
      if (TWOWAY_TOKENS.has(lower)) {
        inboundOnly = false;
        continue;
      }
      if (INBOUND_ONLY_TOKENS.has(lower)) {
        inboundOnly = true;
        continue;
      }
      nameParts.push(token);
    }
    const sharedName =
      ids.length === 1 && nameParts.length ? nameParts.join(' ') : undefined;

    const session = getSession(forum.cfg.tenantId);
    if (session?.status !== 'active') {
      await ctx.reply('Tenant chưa /login Zalo (session không active).');
      return;
    }

    if (ids.length > 1) {
      await ctx.reply(
        `Đang thêm ${ids.length} id${inboundOnly ? ' (readonly)' : ''}…`,
      );
    }

    // Prefetch tên để batch
    let groupNameById = new Map<string, string>();
    let friendNameById = new Map<string, string>();
    if (sessionManager.isRunning(forum.cfg.tenantId)) {
      try {
        const groups = await sessionManager.refreshGroups(forum.cfg.tenantId);
        groupNameById = new Map(groups.map((g) => [g.groupId, g.name]));
      } catch {
        // ignore
      }
      try {
        const friends = await sessionManager.refreshFriends(forum.cfg.tenantId);
        friendNameById = new Map(friends.map((f) => [f.userId, f.name]));
      } catch {
        // ignore
      }
    }

    const lines: string[] = [];
    let ok = 0;
    let fail = 0;
    for (const zaloId of ids) {
      try {
        const kind =
          forceKind ??
          (groupNameById.has(zaloId)
            ? 'group'
            : friendNameById.has(zaloId)
              ? 'user'
              : 'group');
        const displayName =
          sharedName ||
          (kind === 'group'
            ? groupNameById.get(zaloId)
            : friendNameById.get(zaloId));

        if (displayName) {
          const { upsertGroupCache } = await import('../db/rules.js');
          upsertGroupCache(forum.cfg.tenantId, zaloId, displayName);
        }

        const { rule, created, tgDest } = await upsertRuleWithTelegram({
          tenantId: forum.cfg.tenantId,
          sourceGroupId: zaloId,
          zaloTargets: [],
          wantsTelegram: true,
          filterMode: 'all',
          inboundOnly,
          threadKind: kind,
          mergeExistingZalo: true,
        });
        ok += 1;
        const modeTag = inboundOnly ? ' readonly' : '';
        lines.push(
          `${created ? '+' : '~'} [${kind}]${modeTag} ${displayName ?? '—'} id=${zaloId} → ${tgDest ?? '?'} rule=#${rule.id}`,
        );

        // Auto-backfill lịch sử cho group mới map
        if (kind === 'group' && tgDest && sessionManager.isRunning(forum.cfg.tenantId)) {
          const topicId = parseTelegramDest(tgDest);
          const topic = topicId != null ? findTopicById(topicId) : null;
          const adapter = sessionManager.getAdapter(forum.cfg.tenantId);
          const api = getTelegramApi();
          if (topic && adapter && api) {
            try {
              const hist = await backfillGroupHistory(
                api,
                adapter,
                topic,
                GROUP_HISTORY_DEFAULT_LIMIT,
              );
              lines.push(
                `  ↳ history +${hist.loaded}` +
                  (hist.skipped ? ` (có sẵn ${hist.skipped})` : '') +
                  (hist.failed ? ` lỗi ${hist.failed}` : ''),
              );
            } catch (histErr) {
              lines.push(
                `  ↳ history lỗi: ${histErr instanceof Error ? histErr.message : histErr}`,
              );
            }
          }
        }
      } catch (err) {
        fail += 1;
        logger.error({ err, zaloId }, 'useradd failed');
        lines.push(
          `✗ ${zaloId} — ${err instanceof Error ? err.message : 'lỗi'}`,
        );
      }
    }

    await replyChunks(
      (t) => ctx.reply(t),
      [`✅ useradd xong: ok=${ok} fail=${fail}`, ...lines].join('\n'),
    );
  });

  bot.command(['userdel', 'user_del'], async (ctx) => {
    const forum = requireForumAdmin(ctx);
    if (!forum) return;
    const raw = (ctx.message?.text ?? '').replace(/^\/\S+\s*/, '').trim();
    const topicFromCtx = ctx.message?.message_thread_id
      ? findTopicById(ctx.message.message_thread_id)
      : null;

    const targets: Array<{ ref: string; topic: TelegramTopic | null }> = [];

    if (!raw && topicFromCtx && topicFromCtx.tenantId === forum.cfg.tenantId) {
      targets.push({
        ref: String(topicFromCtx.telegramTopicId),
        topic: topicFromCtx,
      });
    } else if (raw) {
      const { ids } = takeLeadingIds(raw.split(/\s+/).filter(Boolean));
      const refs = ids.length > 0 ? ids : parseCommaIds(raw);
      const all = listTopicsByTenant(forum.cfg.tenantId);
      for (const ref of refs) {
        const asNum = Number(ref);
        let topic =
          Number.isFinite(asNum) && asNum > 0 ? findTopicById(asNum) : null;
        if (!topic || topic.tenantId !== forum.cfg.tenantId) {
          topic = all.find((t) => t.sourceGroupId === ref) ?? null;
        }
        if (topic && topic.tenantId !== forum.cfg.tenantId) topic = null;
        targets.push({ ref, topic });
      }
    }

    if (targets.length === 0) {
      await ctx.reply(
        'Chạy trong topic hoặc:\n/userdel <topicId|zaloId>\n/userdel <id1>,<id2>',
      );
      return;
    }

    if (targets.length > 1) {
      await ctx.reply(`Đang xóa ${targets.length} map…`);
    }

    const lines: string[] = [];
    let ok = 0;
    let fail = 0;
    for (const { ref, topic } of targets) {
      if (!topic || topic.tenantId !== forum.cfg.tenantId) {
        fail += 1;
        lines.push(`✗ ${ref} — không tìm thấy`);
        continue;
      }
      try {
        if (topic.ruleId != null) {
          const rule = getRule(topic.ruleId);
          if (rule) {
            const rest = rule.targets.filter(
              (t) => t !== telegramDestKey(topic.telegramTopicId),
            );
            if (rest.length === 0) {
              deleteRule(topic.ruleId);
            } else {
              getDb()
                .prepare(
                  `DELETE FROM rule_targets WHERE rule_id = ? AND dest_group_id = ?`,
                )
                .run(topic.ruleId, telegramDestKey(topic.telegramTopicId));
            }
          }
        }
        deleteTelegramTopic(topic.telegramTopicId);
        try {
          await bot.api.deleteForumTopic(forum.chatId, topic.telegramTopicId);
        } catch {
          // topic có thể đã xóa tay
        }
        ok += 1;
        lines.push(
          `✓ topic #${topic.telegramTopicId} ← ${topic.sourceGroupId}`,
        );
      } catch (err) {
        fail += 1;
        lines.push(
          `✗ ${ref} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await replyChunks(
      (t) => ctx.reply(t),
      [`✅ userdel: ok=${ok} fail=${fail}`, ...lines].join('\n'),
    );
  });

  bot.command(['tginfo', 'user'], async (ctx) => {
    const forum = requireForumAdmin(ctx);
    if (!forum) return;
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Chạy lệnh trong một topic.');
      return;
    }
    const topic = findTopicById(topicId);
    if (!topic || topic.tenantId !== forum.cfg.tenantId) {
      await ctx.reply(`Topic #${topicId} chưa map.`);
      return;
    }
    await ctx.reply(
      [
        `Topic #${topic.telegramTopicId}`,
        `Tenant: #${topic.tenantId}`,
        `Zalo group: ${topic.sourceGroupId}`,
        `Rule: ${topic.ruleId ?? '—'}`,
        `Mode: ${topic.inboundOnly ? 'readonly' : 'twoway'}`,
        `missing: ${topic.topicMissing ? 'yes' : 'no'}`,
        `title: ${topic.topicTitle ?? '—'}`,
      ].join('\n'),
    );
  });

  bot.command('recreate', async (ctx) => {
    const forum = requireForumAdmin(ctx);
    if (!forum) return;
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Chạy /recreate trong topic cần tạo lại.');
      return;
    }
    const existing = findTopicById(topicId);
    if (!existing || existing.tenantId !== forum.cfg.tenantId) {
      await ctx.reply('Topic không thuộc forum này.');
      return;
    }
    try {
      const topic = await recreateTopicById(topicId);
      if (!topic) {
        await ctx.reply('Không tìm thấy map topic.');
        return;
      }
      await ctx.reply(`Đã tạo lại topic #${topic.telegramTopicId} (cũ #${topicId}).`);
    } catch (err) {
      await ctx.reply(`Lỗi: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command(['readonly', 'ro', 'oneway', '1way'], async (ctx) => {
    await setTopicMode(ctx, true);
  });
  bot.command(['twoway', 'readwrite', 'rw'], async (ctx) => {
    await setTopicMode(ctx, false);
  });

  bot.command(['search', 'find'], async (ctx) => {
    const forum = requireForumAdmin(ctx);
    if (!forum) return;
    const q = (ctx.message?.text ?? '').replace(/^\/\S+\s*/, '').trim().toLowerCase();
    if (!q) {
      await ctx.reply('Dùng: /search <tên hoặc zalo id>');
      return;
    }
    const topics = listTopicsByTenant(forum.cfg.tenantId);
    const hits = topics.filter((t) => {
      const title = (t.topicTitle ?? '').toLowerCase();
      return (
        title.includes(q) ||
        t.sourceGroupId.includes(q) ||
        String(t.telegramTopicId).includes(q)
      );
    });
    if (hits.length === 0) {
      await ctx.reply('Không thấy kết quả.');
      return;
    }
    const lines = hits.slice(0, 30).map((t) => {
      const flag = t.inboundOnly ? 'RO' : 'RW';
      return `#${t.telegramTopicId} [${t.threadKind}/${flag}] ${t.topicTitle ?? '—'} ← \`${t.sourceGroupId}\``;
    });
    await replyChunks((text) => ctx.reply(text, { parse_mode: 'Markdown' }), lines.join('\n'));
  });

  bot.command(['useredit', 'user_edit'], async (ctx) => {
    const forum = requireForumAdmin(ctx);
    if (!forum) return;
    const raw = (ctx.message?.text ?? '').replace(/^\/\S+\s*/, '').trim();
    const tokens = raw.split(/\s+/).filter(Boolean);
    const { ids, rest } = takeLeadingIds(tokens);
    if (ids.length === 0 || rest.length === 0) {
      await ctx.reply(
        [
          'Dùng:',
          '/useredit <zalo_id> name=Tên inbound_only=1 kind=group',
          '/useredit <id1>,<id2> inbound_only=1',
          'inbound_only: 0|1 · kind: user|group',
        ].join('\n'),
      );
      return;
    }

    const patch: {
      displayName?: string;
      inboundOnly?: boolean;
      threadKind?: 'user' | 'group';
      enabled?: boolean;
    } = {};

    for (const token of rest) {
      const eq = token.indexOf('=');
      if (eq <= 0) continue;
      const key = token.slice(0, eq).toLowerCase();
      const value = token.slice(eq + 1);
      if (!value) continue;
      if (key === 'name' || key === 'display_name' || key === 'display') {
        patch.displayName = value.replace(/_/g, ' ');
      } else if (key === 'kind' || key === 'thread' || key === 'threadkind') {
        if (value !== 'user' && value !== 'group') {
          await ctx.reply('kind phải là user|group');
          return;
        }
        patch.threadKind = value;
      } else if (
        key === 'inbound_only' ||
        key === 'inboundonly' ||
        key === 'readonly' ||
        key === 'ro'
      ) {
        if (value !== '0' && value !== '1') {
          await ctx.reply('inbound_only phải là 0|1');
          return;
        }
        patch.inboundOnly = value === '1';
      } else if (key === 'enabled') {
        if (value !== '0' && value !== '1') {
          await ctx.reply('enabled phải là 0|1');
          return;
        }
        patch.enabled = value === '1';
      } else {
        await ctx.reply(`Không hiểu key: ${key}`);
        return;
      }
    }

    if (Object.keys(patch).length === 0) {
      await ctx.reply('Không có trường nào để sửa.');
      return;
    }

    const all = listTopicsByTenant(forum.cfg.tenantId);
    const lines: string[] = [];
    let ok = 0;
    let fail = 0;
    for (const zaloId of ids) {
      const topic =
        all.find((t) => t.sourceGroupId === zaloId) ??
        ( /^\d+$/.test(zaloId) ? findTopicById(Number(zaloId)) : null);
      if (!topic || topic.tenantId !== forum.cfg.tenantId) {
        fail += 1;
        lines.push(`✗ không tìm thấy: ${zaloId}`);
        continue;
      }
      if (patch.inboundOnly != null) setInboundOnly(topic.telegramTopicId, patch.inboundOnly);
      if (patch.threadKind) setThreadKind(topic.telegramTopicId, patch.threadKind);
      if (patch.displayName) {
        updateTopicTitle(topic.telegramTopicId, patch.displayName);
        upsertGroupCache(forum.cfg.tenantId, topic.sourceGroupId, patch.displayName);
        try {
          const api = getTelegramApi();
          if (api) {
            await api.editForumTopic(topic.telegramChatId, topic.telegramTopicId, {
              name: patch.displayName.slice(0, 128),
            });
          }
        } catch {
          // ignore rename errors
        }
      }
      if (patch.enabled != null && topic.ruleId != null) {
        setRuleEnabled(topic.ruleId, patch.enabled);
      }
      ok += 1;
      lines.push(`~ #${topic.telegramTopicId} ← ${topic.sourceGroupId}`);
    }
    await replyChunks(
      (t) => ctx.reply(t),
      [`✅ useredit xong: ok=${ok} fail=${fail}`, ...lines].join('\n'),
    );
  });

  bot.command(['history', 'loadhistory', 'backfill'], async (ctx) => {
    const forum = requireForumAdmin(ctx);
    if (!forum) return;
    const topicId = ctx.message?.message_thread_id;
    if (!topicId) {
      await ctx.reply('Chỉ dùng /history trong topic (không dùng General).');
      return;
    }
    const topic = findTopicById(topicId);
    if (!topic || topic.tenantId !== forum.cfg.tenantId) {
      await ctx.reply('Topic chưa map.');
      return;
    }
    if (topic.threadKind !== 'group') {
      await ctx.reply('Chỉ nạp lịch sử cho topic group.');
      return;
    }
    if (!sessionManager.isRunning(forum.cfg.tenantId)) {
      await ctx.reply('Session Zalo chưa chạy.');
      return;
    }
    const adapter = sessionManager.getAdapter(forum.cfg.tenantId);
    const api = getTelegramApi();
    if (!adapter || !api) {
      await ctx.reply('Adapter/API chưa sẵn sàng.');
      return;
    }
    await ctx.reply(
      `📜 Đang nạp ${GROUP_HISTORY_DEFAULT_LIMIT} tin gần nhất của group ${topic.sourceGroupId}…`,
    );
    try {
      const hist = await backfillGroupHistory(
        api,
        adapter,
        topic,
        GROUP_HISTORY_DEFAULT_LIMIT,
      );
      if (hist.emptyHint) {
        await ctx.reply(`⚠️ ${hist.emptyHint}`);
        return;
      }
      await ctx.reply(
        hist.loaded === 0 && hist.skipped > 0
          ? `ℹ️ Không có tin mới: ${hist.skipped} tin đã có trên topic.`
          : `✅ Lịch sử: +${hist.loaded} tin mới` +
              (hist.skipped ? `, đã có sẵn ${hist.skipped}` : '') +
              (hist.failed ? `, lỗi ${hist.failed}` : ''),
      );
    } catch (err) {
      logger.error({ err, topicId }, 'manual history backfill failed');
      await ctx.reply(
        `⚠️ Nạp lịch sử thất bại: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  bot.command(['del', 'delete', 'xoá', 'xoa'], async (ctx) => {
    const forum = requireForumAdmin(ctx);
    if (!forum) return;
    const reply = ctx.message?.reply_to_message;
    if (!reply) {
      await ctx.reply('Reply vào tin cần xoá rồi gõ /del');
      return;
    }
    const adapter = sessionManager.getAdapter(forum.cfg.tenantId);
    if (!adapter) {
      await ctx.reply('Session Zalo chưa chạy.');
      return;
    }
    const chatId = String(ctx.chat!.id);
    const targetId = reply.message_id;
    const result = await syncTelegramDeleteToZalo(adapter, chatId, targetId);
    try {
      await ctx.api.deleteMessage(chatId, targetId);
    } catch (err) {
      logger.warn({ err, targetId }, 'Failed to delete Telegram message on /del');
    }
    try {
      await ctx.deleteMessage();
    } catch {
      // ignore
    }
    if (!result.ok) {
      await ctx.reply(`Đã thử xoá TG. Zalo: ${result.reason}`).catch(() => undefined);
    }
  });

  bot.command(
    ['zalochats', 'zalo_chats', 'zalogroups', 'zalo_groups', 'groups', 'friends', 'zalofriends'],
    async (ctx) => {
    const forum = requireForumAdmin(ctx);
    if (!forum) return;
    if (!sessionManager.isRunning(forum.cfg.tenantId)) {
      await ctx.reply('Session Zalo chưa chạy. User cần /login trên Zalo bot.');
      return;
    }
    const cmd = (ctx.message?.text ?? '').split(/\s+/)[0]?.replace(/^\//, '').split('@')[0] ?? '';
    const arg = (ctx.message?.text ?? '').replace(/^\/\S+\s*/, '').trim().toLowerCase();
    const focusFriends =
      cmd === 'friends' ||
      cmd === 'zalofriends' ||
      arg === 'user' ||
      arg === 'users' ||
      arg === '1-1';
    const focusGroupsOnly =
      cmd === 'zalogroups' ||
      cmd === 'zalo_groups' ||
      cmd === 'groups' ||
      arg === 'group' ||
      arg === 'groups';
    try {
      const lines: string[] = [];
      if (!focusGroupsOnly) {
        const friends = await sessionManager.refreshFriends(forum.cfg.tenantId);
        lines.push('Chat 1-1 (theo thời gian tin):');
        if (friends.length === 0) lines.push('(trống)');
        else {
          for (const f of friends.slice(0, 40)) {
            const ago = formatRelativeTime(f.lastActiveAt);
            const pin = f.pinned ? '📌 ' : '';
            lines.push(
              `${pin}${f.name} — \`${f.userId}\`${ago ? ` · ${ago}` : ''}`,
            );
          }
        }
      }
      if (!focusFriends) {
        const groups = await sessionManager.refreshGroups(forum.cfg.tenantId);
        if (lines.length) lines.push('');
        lines.push('Group (theo thời gian tin):');
        if (groups.length === 0) lines.push('(trống)');
        else {
          for (const g of groups.slice(0, 40)) {
            const ago = formatRelativeTime(g.lastActiveAt);
            const pin = g.pinned ? '📌 ' : '';
            lines.push(
              `${pin}${g.name} — \`${g.groupId}\`${ago ? ` · ${ago}` : ''}`,
            );
          }
        }
      }
      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`Lỗi: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
  );

  bot.on('edited_message:text', async (ctx) => {
    const forum = requireForumAdmin(ctx);
    if (!forum) return;
    const msg = ctx.editedMessage;
    if (!msg?.text || msg.text.startsWith('/')) return;
    const topicId = msg.message_thread_id;
    if (!topicId) return;
    const adapter = sessionManager.getAdapter(forum.cfg.tenantId);
    if (!adapter) return;
    const result = await syncTelegramEditToZalo(
      adapter,
      String(msg.chat.id),
      msg.message_id,
      msg.text,
      msg.entities?.map((e) => ({
        type: e.type,
        offset: e.offset,
        length: e.length,
      })),
    );
    if (!result.ok && result.reason !== 'no-link' && result.reason !== 'not-outbound') {
      logger.warn(
        { reason: result.reason, messageId: msg.message_id, topicId },
        'Telegram edit → Zalo sync failed',
      );
      await ctx.reply(`Sửa Zalo thất bại: ${result.reason}`).catch(() => undefined);
    }
  });

  bot.on('message:text', async (ctx) => {
    const forum = requireForumAdmin(ctx);
    if (!forum) return;
    if (ctx.from?.is_bot) return;
    if (ctx.message.text?.startsWith('/')) return;
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;

    try {
      await forwardTopicReplyToZalo({
        topicId,
        text: ctx.message.text,
        entities: ctx.message.entities?.map((e) => ({
          type: e.type,
          offset: e.offset,
          length: e.length,
        })),
        telegramMessageId: ctx.message.message_id,
        replyToTelegramMessageId: ctx.message.reply_to_message?.message_id,
      });
    } catch (err) {
      logger.error({ err, topicId }, 'Topic→Zalo text failed');
      try {
        await ctx.reply(`❌ Gửi Zalo lỗi: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        // ignore
      }
    }
  });

  bot.on('message:photo', async (ctx) => {
    const forum = requireForumAdmin(ctx);
    if (!forum) return;
    if (ctx.from?.is_bot) return;
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;

    const photos = ctx.message.photo;
    const best = photos[photos.length - 1];
    if (!best) return;

    const albumId = ctx.message.media_group_id;
    if (albumId) {
      const key = `${topicId}:${albumId}`;
      let pending = pendingAlbums.get(key);
      if (!pending) {
        pending = {
          timer: setTimeout(() => {
            void flushAlbum(key);
          }, 900),
          topicId,
          fileIds: [],
          caption: ctx.message.caption,
          captionEntities: ctx.message.caption_entities?.map((e) => ({
            type: e.type,
            offset: e.offset,
            length: e.length,
          })),
        };
        pendingAlbums.set(key, pending);
      }
      pending.fileIds.push(best.file_id);
      if (ctx.message.caption) {
        pending.caption = ctx.message.caption;
        pending.captionEntities = ctx.message.caption_entities?.map((e) => ({
          type: e.type,
          offset: e.offset,
          length: e.length,
        }));
      }
      return;
    }

    try {
      await forwardTopicReplyToZalo({
        topicId,
        photoFileIds: [best.file_id],
        caption: ctx.message.caption,
        captionEntities: ctx.message.caption_entities?.map((e) => ({
          type: e.type,
          offset: e.offset,
          length: e.length,
        })),
        telegramMessageId: ctx.message.message_id,
        replyToTelegramMessageId: ctx.message.reply_to_message?.message_id,
      });
    } catch (err) {
      logger.error({ err, topicId }, 'Topic→Zalo photo failed');
      try {
        await ctx.reply(`❌ Gửi ảnh Zalo lỗi: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        // ignore
      }
    }
  });
}

async function setTopicMode(ctx: Context, inboundOnly: boolean): Promise<void> {
  const forum = requireForumAdmin(ctx);
  if (!forum) return;
  const topicId = ctx.message?.message_thread_id;
  if (!topicId) {
    await ctx.reply('Chạy trong topic.');
    return;
  }
  const topic = findTopicById(topicId);
  if (!topic || topic.tenantId !== forum.cfg.tenantId) {
    await ctx.reply('Topic chưa map.');
    return;
  }
  setInboundOnly(topicId, inboundOnly);
  await ctx.reply(inboundOnly ? 'Đã chuyển readonly (chỉ Zalo→TG).' : 'Đã chuyển twoway (reply → Zalo).');
}

async function flushAlbum(key: string): Promise<void> {
  const pending = pendingAlbums.get(key);
  pendingAlbums.delete(key);
  if (!pending || pending.fileIds.length === 0) return;
  try {
    await forwardTopicReplyToZalo({
      topicId: pending.topicId,
      photoFileIds: pending.fileIds,
      caption: pending.caption,
      captionEntities: pending.captionEntities,
    });
  } catch (err) {
    logger.error({ err, topicId: pending.topicId }, 'Topic→Zalo album failed');
  }
}
