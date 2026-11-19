import { getDb } from './client.js';
import { parseIdList } from '../config/env.js';

export type TenantTelegram = {
  tenantId: number;
  forumGroupId: string;
  adminIds: string[];
  enabled: boolean;
  /** Topic gom mọi tin 1-1 chưa /useradd */
  dmInboxTopicId: number | null;
  dmInboxEnabled: boolean;
  updatedAt: string;
};

type Row = {
  tenant_id: number;
  forum_group_id: string;
  admin_ids: string;
  enabled: number;
  dm_inbox_topic_id?: number | null;
  dm_inbox_enabled?: number | null;
  updated_at: string;
};

function mapRow(row: Row): TenantTelegram {
  return {
    tenantId: row.tenant_id,
    forumGroupId: row.forum_group_id,
    adminIds: parseIdList(row.admin_ids ?? ''),
    enabled: row.enabled === 1,
    dmInboxTopicId:
      row.dm_inbox_topic_id != null && Number(row.dm_inbox_topic_id) > 0
        ? Number(row.dm_inbox_topic_id)
        : null,
    dmInboxEnabled: Number(row.dm_inbox_enabled ?? 0) === 1,
    updatedAt: row.updated_at,
  };
}

export function getTenantTelegram(tenantId: number): TenantTelegram | null {
  const row = getDb()
    .prepare(`SELECT * FROM tenant_telegram WHERE tenant_id = ?`)
    .get(tenantId) as Row | undefined;
  return row ? mapRow(row) : null;
}

export function findTenantTelegramByForum(forumGroupId: string): TenantTelegram | null {
  const row = getDb()
    .prepare(`SELECT * FROM tenant_telegram WHERE forum_group_id = ?`)
    .get(String(forumGroupId)) as Row | undefined;
  return row ? mapRow(row) : null;
}

export function bindTenantForum(input: {
  tenantId: number;
  forumGroupId: string;
  adminIds?: string[];
}): TenantTelegram {
  const forumGroupId = String(input.forumGroupId).trim();
  if (!forumGroupId) throw new Error('Thiếu forum group id');

  const taken = findTenantTelegramByForum(forumGroupId);
  if (taken && taken.tenantId !== input.tenantId) {
    throw new Error(
      `Forum ${forumGroupId} đã được tenant #${taken.tenantId} dùng`,
    );
  }

  const existing = getTenantTelegram(input.tenantId);
  const adminIds =
    input.adminIds ?? existing?.adminIds ?? [];
  const adminRaw = adminIds.join(',');

  getDb()
    .prepare(
      `INSERT INTO tenant_telegram (tenant_id, forum_group_id, admin_ids, enabled, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'))
       ON CONFLICT(tenant_id) DO UPDATE SET
         forum_group_id = excluded.forum_group_id,
         admin_ids = excluded.admin_ids,
         enabled = 1,
         updated_at = datetime('now')`,
    )
    .run(input.tenantId, forumGroupId, adminRaw);

  return getTenantTelegram(input.tenantId)!;
}

export function setTenantTelegramAdmins(
  tenantId: number,
  adminIds: string[],
): TenantTelegram | null {
  const existing = getTenantTelegram(tenantId);
  if (!existing) return null;
  getDb()
    .prepare(
      `UPDATE tenant_telegram
       SET admin_ids = ?, updated_at = datetime('now')
       WHERE tenant_id = ?`,
    )
    .run(adminIds.join(','), tenantId);
  return getTenantTelegram(tenantId);
}

export function setTenantTelegramEnabled(
  tenantId: number,
  enabled: boolean,
): TenantTelegram | null {
  const existing = getTenantTelegram(tenantId);
  if (!existing) return null;
  getDb()
    .prepare(
      `UPDATE tenant_telegram
       SET enabled = ?, updated_at = datetime('now')
       WHERE tenant_id = ?`,
    )
    .run(enabled ? 1 : 0, tenantId);
  return getTenantTelegram(tenantId);
}

/** Bật/tắt + gắn topic gom tin 1-1 chưa map. */
export function setDmInbox(
  tenantId: number,
  opts: { enabled?: boolean; topicId?: number | null },
): TenantTelegram | null {
  const existing = getTenantTelegram(tenantId);
  if (!existing) return null;
  const enabled =
    opts.enabled != null ? opts.enabled : existing.dmInboxEnabled;
  const topicId =
    opts.topicId !== undefined ? opts.topicId : existing.dmInboxTopicId;
  getDb()
    .prepare(
      `UPDATE tenant_telegram
       SET dm_inbox_enabled = ?,
           dm_inbox_topic_id = ?,
           updated_at = datetime('now')
       WHERE tenant_id = ?`,
    )
    .run(enabled ? 1 : 0, topicId, tenantId);
  return getTenantTelegram(tenantId);
}

export function unbindTenantForum(tenantId: number): boolean {
  const info = getDb()
    .prepare(`DELETE FROM tenant_telegram WHERE tenant_id = ?`)
    .run(tenantId);
  return info.changes > 0;
}

export function requireTenantForum(tenantId: number): TenantTelegram {
  const cfg = getTenantTelegram(tenantId);
  if (!cfg || !cfg.enabled) {
    throw new Error(
      'Chưa gắn forum Telegram. Dùng /tgbind <forum_id> trên Zalo bot (sau khi add bot vào forum có Topics).',
    );
  }
  return cfg;
}

/** Global env admins + admin list của tenant forum. */
export function isForumAdmin(
  cfg: TenantTelegram,
  userId: number | undefined,
  globalAdminIds: string[],
): boolean {
  if (userId == null) return false;
  const id = String(userId);
  if (globalAdminIds.includes(id)) return true;
  return cfg.adminIds.includes(id);
}
