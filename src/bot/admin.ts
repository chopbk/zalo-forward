import { isAdmin } from '../config/env.js';
import {
  findTenantByBotUserId,
  findTenantById,
  getSession,
  listTenants,
  setTenantStatus,
  type Tenant,
} from '../db/tenants.js';
import { listRules } from '../db/rules.js';
import { countPendingJobs } from '../db/jobs.js';
import { sessionManager } from '../personal/manager.js';
import type { ZaloBotControl } from './adapter.js';
import { ADMIN_HELP } from './help.js';

function resolveTenantRef(ref: string, pendingOnly = false): Tenant | null {
  const list = pendingOnly ? listTenants('pending') : listTenants();
  const asNum = Number(ref);
  if (Number.isFinite(asNum) && asNum >= 1 && asNum <= list.length && String(asNum) === ref) {
    // 1-based index into filtered list when ref is small ordinal — only if not matching an id
    const byId = findTenantById(asNum);
    if (byId) return byId;
    return list[asNum - 1] ?? null;
  }
  if (Number.isFinite(asNum)) {
    const byId = findTenantById(asNum);
    if (byId) return byId;
  }
  return findTenantByBotUserId(ref);
}

export async function handleAdminCommand(
  bot: ZaloBotControl,
  zaloUserId: string,
  text: string,
): Promise<boolean> {
  if (!isAdmin(zaloUserId)) return false;

  const parts = text.trim().split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase();
  const arg = parts[1];

  switch (cmd) {
    case '/adminhelp':
      await bot.sendText(zaloUserId, ADMIN_HELP);
      return true;

    case '/pending': {
      const pending = listTenants('pending');
      if (pending.length === 0) {
        await bot.sendText(zaloUserId, 'Không có ai chờ duyệt.');
        return true;
      }
      const lines = pending.map(
        (t, i) =>
          `${i + 1}. #${t.id} ${t.displayName ?? '?'} — bot_uid=${t.zaloBotUserId}`,
      );
      await bot.sendText(
        zaloUserId,
        `Chờ duyệt (${pending.length}):\n${lines.join('\n')}\n\n/approve <id> hoặc /reject <id>`,
      );
      return true;
    }

    case '/approve': {
      if (!arg) {
        await bot.sendText(zaloUserId, 'Dùng: /approve <tenant_id|bot_uid>');
        return true;
      }
      const t = resolveTenantRef(arg, true) ?? resolveTenantRef(arg);
      if (!t) {
        await bot.sendText(zaloUserId, 'Không tìm thấy user.');
        return true;
      }
      setTenantStatus(t.id, 'approved');
      await bot.sendText(zaloUserId, `Đã duyệt #${t.id} (${t.zaloBotUserId}).`);
      try {
        await bot.sendText(
          t.zaloBotUserId,
          'Bạn đã được duyệt! Gõ /login để đăng nhập Zalo cá nhân, rồi /groups và /addrule.',
        );
      } catch {
        // ignore
      }
      return true;
    }

    case '/reject': {
      if (!arg) {
        await bot.sendText(zaloUserId, 'Dùng: /reject <tenant_id|bot_uid>');
        return true;
      }
      const t = resolveTenantRef(arg);
      if (!t) {
        await bot.sendText(zaloUserId, 'Không tìm thấy user.');
        return true;
      }
      await sessionManager.stopTenant(t.id);
      setTenantStatus(t.id, 'rejected');
      await bot.sendText(zaloUserId, `Đã từ chối #${t.id}.`);
      try {
        await bot.sendText(t.zaloBotUserId, 'Yêu cầu đăng ký bị từ chối.');
      } catch {
        // ignore
      }
      return true;
    }

    case '/users': {
      const all = listTenants();
      if (all.length === 0) {
        await bot.sendText(zaloUserId, 'Chưa có user.');
        return true;
      }
      const lines = all.map((t) => {
        const s = getSession(t.id);
        return `#${t.id} ${t.displayName ?? '-'} [${t.status}] relay=${t.relayEnabled ? 'on' : 'off'} session=${s?.status ?? 'none'}`;
      });
      await bot.sendText(zaloUserId, lines.join('\n'));
      return true;
    }

    case '/suspend': {
      if (!arg) {
        await bot.sendText(zaloUserId, 'Dùng: /suspend <id>');
        return true;
      }
      const t = resolveTenantRef(arg);
      if (!t) {
        await bot.sendText(zaloUserId, 'Không tìm thấy.');
        return true;
      }
      await sessionManager.stopTenant(t.id);
      setTenantStatus(t.id, 'suspended');
      await bot.sendText(zaloUserId, `Đã suspend #${t.id}.`);
      return true;
    }

    case '/unsuspend': {
      if (!arg) {
        await bot.sendText(zaloUserId, 'Dùng: /unsuspend <id>');
        return true;
      }
      const t = resolveTenantRef(arg);
      if (!t) {
        await bot.sendText(zaloUserId, 'Không tìm thấy.');
        return true;
      }
      setTenantStatus(t.id, 'approved');
      await bot.sendText(zaloUserId, `Đã unsuspend #${t.id} → approved. User cần /resume nếu đã login.`);
      return true;
    }

    case '/tenant': {
      if (!arg) {
        await bot.sendText(zaloUserId, 'Dùng: /tenant <id>');
        return true;
      }
      const t = resolveTenantRef(arg);
      if (!t) {
        await bot.sendText(zaloUserId, 'Không tìm thấy.');
        return true;
      }
      const s = getSession(t.id);
      const rules = listRules(t.id);
      const pendingJobs = countPendingJobs(t.id);
      await bot.sendText(
        zaloUserId,
        [
          `Tenant #${t.id}`,
          `bot_uid: ${t.zaloBotUserId}`,
          `name: ${t.displayName ?? '-'}`,
          `status: ${t.status}`,
          `relay: ${t.relayEnabled ? 'on' : 'off'}`,
          `session: ${s?.status ?? 'none'} own=${s?.zaloOwnId ?? '-'}`,
          `error: ${s?.lastError ?? '-'}`,
          `rules: ${rules.length}`,
          `pending jobs: ${pendingJobs}`,
          `listener: ${sessionManager.isRunning(t.id) ? 'running' : 'stopped'}`,
        ].join('\n'),
      );
      return true;
    }

    default:
      return false;
  }
}
