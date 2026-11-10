import { getEnv } from '../config/env.js';
import { getDb } from './client.js';

export type Admin = {
  zaloBotUserId: string;
  displayName: string | null;
  createdAt: string;
};

export function isDbAdmin(zaloBotUserId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM admins WHERE zalo_bot_user_id = ?')
    .get(String(zaloBotUserId)) as { ok: number } | undefined;
  return Boolean(row);
}

/** Env seed admins + DB-claimed admins */
export function isAdmin(zaloBotUserId: string): boolean {
  const id = String(zaloBotUserId);
  if (getEnv().adminZaloUserIds.includes(id)) return true;
  return isDbAdmin(id);
}

export function listAdmins(): Admin[] {
  const rows = getDb()
    .prepare(
      `SELECT zalo_bot_user_id, display_name, created_at FROM admins ORDER BY created_at ASC`,
    )
    .all() as Array<{
    zalo_bot_user_id: string;
    display_name: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    zaloBotUserId: r.zalo_bot_user_id,
    displayName: r.display_name,
    createdAt: r.created_at,
  }));
}

/** All ids to notify (DB + env), unique */
export function listAdminNotifyIds(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of getEnv().adminZaloUserIds) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (const a of listAdmins()) {
    if (!seen.has(a.zaloBotUserId)) {
      seen.add(a.zaloBotUserId);
      out.push(a.zaloBotUserId);
    }
  }
  return out;
}

export function addAdmin(
  zaloBotUserId: string,
  displayName?: string | null,
): { created: boolean; admin: Admin } {
  const id = String(zaloBotUserId);
  const existing = getDb()
    .prepare('SELECT * FROM admins WHERE zalo_bot_user_id = ?')
    .get(id) as
    | {
        zalo_bot_user_id: string;
        display_name: string | null;
        created_at: string;
      }
    | undefined;

  if (existing) {
    if (displayName && displayName !== existing.display_name) {
      getDb()
        .prepare(`UPDATE admins SET display_name = ? WHERE zalo_bot_user_id = ?`)
        .run(displayName, id);
    }
    return {
      created: false,
      admin: {
        zaloBotUserId: existing.zalo_bot_user_id,
        displayName: displayName ?? existing.display_name,
        createdAt: existing.created_at,
      },
    };
  }

  getDb()
    .prepare(
      `INSERT INTO admins (zalo_bot_user_id, display_name) VALUES (?, ?)`,
    )
    .run(id, displayName ?? null);

  return {
    created: true,
    admin: {
      zaloBotUserId: id,
      displayName: displayName ?? null,
      createdAt: new Date().toISOString(),
    },
  };
}

export function removeAdmin(zaloBotUserId: string): boolean {
  const info = getDb()
    .prepare(`DELETE FROM admins WHERE zalo_bot_user_id = ?`)
    .run(String(zaloBotUserId));
  return info.changes > 0;
}
