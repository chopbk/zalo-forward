import { verifyAdminSetupPassword } from '../config/env.js';
import logger from '../config/logger.js';
import { addAdmin, isAdmin } from '../db/admins.js';
import {
  createOrGetPending,
  findTenantByBotUserId,
  getSession,
  setRelayEnabled,
  upsertSession,
} from '../db/tenants.js';
import {
  deleteRule,
  getRule,
  listGroupCache,
  listRules,
  setRuleEnabled,
} from '../db/rules.js';
import { startQrLogin } from '../personal/login-qr.js';
import { sessionManager } from '../personal/manager.js';
import type { ZaloBotControl, BotInbound } from './adapter.js';
import { handleAdminCommand } from './admin.js';
import {
  clearConversation,
  getConversation,
  handleConversationReply,
  startAddRuleFlow,
  startKeywordsFlow,
} from './flows.js';
import { ADMIN_HELP, USER_HELP } from './help.js';

function requireApproved(zaloUserId: string) {
  const tenant = findTenantByBotUserId(zaloUserId);
  if (!tenant) return { ok: false as const, reason: 'Chưa đăng ký. Gõ /start' };
  if (tenant.status === 'pending') {
    return { ok: false as const, reason: 'Đang chờ admin duyệt.' };
  }
  if (tenant.status === 'rejected') {
    return { ok: false as const, reason: 'Đăng ký bị từ chối.' };
  }
  if (tenant.status === 'suspended') {
    return { ok: false as const, reason: 'Tài khoản bị tạm khóa.' };
  }
  return { ok: true as const, tenant };
}

export function wireBotCommands(bot: ZaloBotControl): void {
  bot.onInbound(async (msg) => {
    try {
      await handleInbound(bot, msg);
    } catch (err) {
      logger.error({ err, user: msg.zaloUserId }, 'Command handler failed');
      try {
        await bot.sendText(
          msg.zaloUserId,
          `Lỗi: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        // ignore
      }
    }
  });
}

async function handleInbound(bot: ZaloBotControl, msg: BotInbound): Promise<void> {
  const text = msg.text.trim();
  const zaloUserId = msg.zaloUserId;
  const lower = text.toLowerCase();

  // Ai cũng xem được id của mình
  if (text === '/whoami' || text === '/myid') {
    await bot.sendText(
      zaloUserId,
      `Zalo user id của bạn (với bot):\n${zaloUserId}\n` +
        (msg.displayName ? `Tên: ${msg.displayName}\n` : '') +
        (isAdmin(zaloUserId)
          ? 'Bạn đang là admin.'
          : 'Chưa phải admin. Claim: /iamadmin <mật khẩu>'),
    );
    return;
  }

  // Claim admin bằng mật khẩu trong .env — không cần biết id trước
  if (text.startsWith('/iamadmin') || text.startsWith('/adminpass')) {
    const password = text.replace(/^\/(iamadmin|adminpass)\s*/i, '').trim();
    if (!password) {
      await bot.sendText(
        zaloUserId,
        'Dùng: /iamadmin <mật_khẩu>\nMật khẩu = ADMIN_SETUP_PASSWORD trong file .env trên server.',
      );
      return;
    }
    if (!verifyAdminSetupPassword(password)) {
      await bot.sendText(zaloUserId, 'Mật khẩu không đúng.');
      return;
    }
    const { created, admin } = addAdmin(zaloUserId, msg.displayName);
    await bot.sendText(
      zaloUserId,
      created
        ? `OK — bạn đã là admin.\nID đã lưu: ${admin.zaloBotUserId}\nGõ /adminhelp`
        : `Bạn đã là admin từ trước.\nID: ${admin.zaloBotUserId}\nGõ /adminhelp`,
    );
    return;
  }

  // Admin commands first
  if (await handleAdminCommand(bot, zaloUserId, text)) return;

  // Conversation wizard
  const tenantExisting = findTenantByBotUserId(zaloUserId);
  if (tenantExisting) {
    const conv = getConversation(zaloUserId);
    if (conv.state !== 'idle') {
      const handled = await handleConversationReply(bot, tenantExisting, text, conv);
      if (handled) return;
    }
  }

  if (
    text === '/start' ||
    lower === 'đăng ký' ||
    lower === 'dang ky' ||
    text === '/register'
  ) {
    const { tenant, created } = createOrGetPending(zaloUserId, msg.displayName);
    if (tenant.status === 'approved') {
      await bot.sendText(
        zaloUserId,
        `Bạn đã được duyệt (#${tenant.id}).\n/login → /groups → /addrule\n/help`,
      );
      return;
    }
    if (tenant.status === 'rejected') {
      await bot.sendText(zaloUserId, 'Đăng ký trước đó bị từ chối. Liên hệ admin.');
      return;
    }
    if (tenant.status === 'suspended') {
      await bot.sendText(zaloUserId, 'Tài khoản đang bị tạm khóa.');
      return;
    }
    await bot.sendText(
      zaloUserId,
      created
        ? `Đã đăng ký (#${tenant.id}). Chờ admin duyệt.\nGõ /status để kiểm tra.`
        : `Bạn đang chờ duyệt (#${tenant.id}).`,
    );
    if (created) {
      await bot.notifyAdmins(
        `User mới chờ duyệt:\n#${tenant.id} ${tenant.displayName ?? ''}\nbot_uid=${tenant.zaloBotUserId}\n→ /approve ${tenant.id}`,
      );
    }
    return;
  }

  if (text === '/help') {
    let help = USER_HELP;
    if (isAdmin(zaloUserId)) help += `\n\n${ADMIN_HELP}`;
    await bot.sendText(zaloUserId, help);
    return;
  }

  if (text === '/cancel') {
    clearConversation(zaloUserId);
    await bot.sendText(zaloUserId, 'Đã về menu. /help');
    return;
  }

  if (text === '/status') {
    const tenant = findTenantByBotUserId(zaloUserId);
    if (!tenant) {
      await bot.sendText(zaloUserId, 'Chưa đăng ký. Gõ /start');
      return;
    }
    const session = getSession(tenant.id);
    const rules = listRules(tenant.id);
    await bot.sendText(
      zaloUserId,
      [
        `ID: #${tenant.id}`,
        `Trạng thái: ${tenant.status}`,
        `Relay: ${tenant.relayEnabled ? 'ON' : 'OFF'}`,
        `Session: ${session?.status ?? 'none'}`,
        `Zalo own id: ${session?.zaloOwnId ?? '-'}`,
        `Listener: ${sessionManager.isRunning(tenant.id) ? 'running' : 'stopped'}`,
        `Số luật: ${rules.length}`,
        session?.lastError ? `Lỗi: ${session.lastError}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return;
  }

  // --- commands requiring approved ---
  const gate = requireApproved(zaloUserId);
  if (
    text === '/login' ||
    text === '/logout' ||
    text === '/groups' ||
    text === '/addrule' ||
    text === '/rules' ||
    text.startsWith('/rules ') ||
    text === '/keywords' ||
    text === '/pause' ||
    text === '/resume'
  ) {
    if (!gate.ok) {
      await bot.sendText(zaloUserId, gate.reason);
      return;
    }
  } else if (!gate.ok) {
    // Unknown command for non-approved
    if (text.startsWith('/')) {
      await bot.sendText(zaloUserId, `${gate.reason}\n/help`);
    }
    return;
  }

  if (!gate.ok) return;
  const tenant = gate.tenant;

  if (text === '/login') {
    upsertSession(tenant.id, { status: 'qr_pending', lastError: null });
    await bot.sendText(
      zaloUserId,
      'Đang tạo QR đăng nhập Zalo cá nhân...\nDùng nick phụ. Không mở Zalo Web song song.',
    );
    try {
      await startQrLogin(tenant.id, {
        onQrReady: async (qrPath) => {
          await bot.sendPhoto(zaloUserId, qrPath, 'Quét QR bằng Zalo trên điện thoại.');
        },
        onScanned: async (name) => {
          await bot.sendText(zaloUserId, `Đã quét (${name ?? 'ok'}) — đang xác nhận...`);
        },
        onExpired: async () => {
          await bot.sendText(zaloUserId, 'QR hết hạn — đang tạo mã mới...');
        },
        onDeclined: async () => {
          upsertSession(tenant.id, { status: 'error', lastError: 'QR declined' });
          await bot.sendText(zaloUserId, 'Bạn đã từ chối QR. Gõ /login để thử lại.');
        },
        onSuccess: async (_session, path, ownId) => {
          upsertSession(tenant.id, {
            sessionPath: path,
            zaloOwnId: ownId,
            status: 'active',
            lastError: null,
          });
          await bot.sendText(
            zaloUserId,
            `Đăng nhập OK (own_id=${ownId}). Đang bật listener...`,
          );
          try {
            const fresh = findTenantByBotUserId(zaloUserId)!;
            await sessionManager.startTenant(fresh, path);
            const groups = await sessionManager.refreshGroups(fresh.id);
            await bot.sendText(
              zaloUserId,
              `Sẵn sàng. Có ${groups.length} group.\nGõ /groups rồi /addrule.`,
            );
          } catch (err) {
            upsertSession(tenant.id, {
              status: 'error',
              lastError: err instanceof Error ? err.message : String(err),
            });
            await bot.sendText(
              zaloUserId,
              `Login OK nhưng start listener lỗi: ${err instanceof Error ? err.message : err}`,
            );
          }
        },
        onError: async (err) => {
          upsertSession(tenant.id, {
            status: 'error',
            lastError: err instanceof Error ? err.message : String(err),
          });
          await bot.sendText(
            zaloUserId,
            `Login lỗi: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      });
    } catch (err) {
      await bot.sendText(
        zaloUserId,
        `Không tạo được QR: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  if (text === '/logout') {
    await sessionManager.logoutTenant(tenant.id);
    await bot.sendText(zaloUserId, 'Đã đăng xuất và dừng chuyển tiếp.');
    return;
  }

  if (text === '/groups') {
    const session = getSession(tenant.id);
    if (session?.status !== 'active') {
      await bot.sendText(zaloUserId, 'Chưa login. Gõ /login');
      return;
    }
    try {
      let groups = listGroupCache(tenant.id);
      if (groups.length === 0 || sessionManager.isRunning(tenant.id)) {
        try {
          const live = await sessionManager.refreshGroups(tenant.id);
          groups = live.map((g) => ({ groupId: g.groupId, name: g.name }));
        } catch {
          // use cache
        }
      }
      if (groups.length === 0) {
        await bot.sendText(zaloUserId, 'Không thấy group nào. Nick có trong group chưa?');
        return;
      }
      const lines = groups.map(
        (g, i) => `${i + 1}. ${g.name ?? '?'} — id=${g.groupId}`,
      );
      // chunk if long
      const chunkSize = 30;
      for (let i = 0; i < lines.length; i += chunkSize) {
        await bot.sendText(zaloUserId, lines.slice(i, i + chunkSize).join('\n'));
      }
    } catch (err) {
      await bot.sendText(
        zaloUserId,
        `Lỗi /groups: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  if (text === '/addrule') {
    const session = getSession(tenant.id);
    if (session?.status !== 'active') {
      await bot.sendText(zaloUserId, 'Cần /login trước.');
      return;
    }
    startAddRuleFlow(zaloUserId);
    await bot.sendText(
      zaloUserId,
      'Thêm luật chuyển tiếp.\nGửi id group NGUỒN (xem /groups).\n/cancel để hủy.',
    );
    return;
  }

  if (text === '/rules' || text.startsWith('/rules ')) {
    const parts = text.split(/\s+/);
    const sub = parts[1]?.toLowerCase();
    const rules = listRules(tenant.id);

    if (!sub) {
      if (rules.length === 0) {
        await bot.sendText(zaloUserId, 'Chưa có luật. /addrule');
        return;
      }
      const lines = rules.map((r) => {
        const flag = r.enabled ? 'ON' : 'OFF';
        return `#${r.id} [${flag}] ${r.sourceGroupId} → ${r.targets.join(',')} | ${r.filterMode}${
          r.filterMode === 'keywords' ? ` (${r.keywords.join('|')})` : ''
        }`;
      });
      await bot.sendText(
        zaloUserId,
        `${lines.join('\n')}\n\n/rules off <id> | /rules on <id> | /rules del <id>`,
      );
      return;
    }

    const id = Number(parts[2]);
    if (!Number.isFinite(id)) {
      await bot.sendText(zaloUserId, 'Dùng: /rules on|off|del <id>');
      return;
    }
    const rule = getRule(id);
    if (!rule || rule.tenantId !== tenant.id) {
      await bot.sendText(zaloUserId, 'Không tìm thấy luật.');
      return;
    }
    if (sub === 'on') {
      setRuleEnabled(id, true);
      await bot.sendText(zaloUserId, `Đã bật luật #${id}`);
      return;
    }
    if (sub === 'off') {
      setRuleEnabled(id, false);
      await bot.sendText(zaloUserId, `Đã tắt luật #${id}`);
      return;
    }
    if (sub === 'del' || sub === 'delete' || sub === 'rm') {
      deleteRule(id);
      await bot.sendText(zaloUserId, `Đã xóa luật #${id}`);
      return;
    }
    await bot.sendText(zaloUserId, 'Dùng: /rules on|off|del <id>');
    return;
  }

  if (text === '/keywords') {
    startKeywordsFlow(zaloUserId);
    await bot.sendText(zaloUserId, 'Gửi id luật cần thêm từ khóa (xem /rules).');
    return;
  }

  if (text === '/pause') {
    setRelayEnabled(tenant.id, false);
    await sessionManager.stopTenant(tenant.id);
    await bot.sendText(zaloUserId, 'Đã tạm dừng chuyển tiếp.');
    return;
  }

  if (text === '/resume') {
    setRelayEnabled(tenant.id, true);
    const session = getSession(tenant.id);
    if (session?.status === 'active' && session.sessionPath) {
      const fresh = findTenantByBotUserId(zaloUserId)!;
      await sessionManager.startTenant(
        { ...fresh, relayEnabled: true },
        session.sessionPath,
      );
      await bot.sendText(zaloUserId, 'Đã bật lại chuyển tiếp.');
    } else {
      await bot.sendText(zaloUserId, 'Relay bật nhưng chưa có session — /login trước.');
    }
    return;
  }

  if (text.startsWith('/')) {
    await bot.sendText(zaloUserId, 'Lệnh không rõ. /help');
  }
}
