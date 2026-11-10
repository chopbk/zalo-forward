import { getDb, type SessionStatus, type TenantRow, type TenantStatus } from './client.js';

export type Tenant = {
  id: number;
  zaloBotUserId: string;
  displayName: string | null;
  status: TenantStatus;
  relayEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SessionInfo = {
  tenantId: number;
  sessionPath: string | null;
  zaloOwnId: string | null;
  status: SessionStatus;
  lastError: string | null;
  updatedAt: string;
};

function mapTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    zaloBotUserId: row.zalo_bot_user_id,
    displayName: row.display_name,
    status: row.status,
    relayEnabled: row.relay_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findTenantByBotUserId(zaloBotUserId: string): Tenant | null {
  const row = getDb()
    .prepare('SELECT * FROM tenants WHERE zalo_bot_user_id = ?')
    .get(zaloBotUserId) as TenantRow | undefined;
  return row ? mapTenant(row) : null;
}

export function findTenantById(id: number): Tenant | null {
  const row = getDb()
    .prepare('SELECT * FROM tenants WHERE id = ?')
    .get(id) as TenantRow | undefined;
  return row ? mapTenant(row) : null;
}

export function listTenants(status?: TenantStatus): Tenant[] {
  if (status) {
    const rows = getDb()
      .prepare('SELECT * FROM tenants WHERE status = ? ORDER BY created_at ASC')
      .all(status) as TenantRow[];
    return rows.map(mapTenant);
  }
  const rows = getDb()
    .prepare('SELECT * FROM tenants ORDER BY created_at ASC')
    .all() as TenantRow[];
  return rows.map(mapTenant);
}

export function createOrGetPending(
  zaloBotUserId: string,
  displayName?: string | null,
): { tenant: Tenant; created: boolean } {
  const existing = findTenantByBotUserId(zaloBotUserId);
  if (existing) {
    if (displayName && displayName !== existing.displayName) {
      getDb()
        .prepare(
          `UPDATE tenants SET display_name = ?, updated_at = datetime('now') WHERE id = ?`,
        )
        .run(displayName, existing.id);
      return { tenant: { ...existing, displayName }, created: false };
    }
    return { tenant: existing, created: false };
  }

  const info = getDb()
    .prepare(
      `INSERT INTO tenants (zalo_bot_user_id, display_name, status)
       VALUES (?, ?, 'pending')`,
    )
    .run(zaloBotUserId, displayName ?? null);

  const tenantId = Number(info.lastInsertRowid);
  getDb()
    .prepare(`INSERT INTO sessions (tenant_id, status) VALUES (?, 'none')`)
    .run(tenantId);

  const tenant = findTenantById(tenantId)!;
  return { tenant, created: true };
}

export function setTenantStatus(id: number, status: TenantStatus): Tenant | null {
  getDb()
    .prepare(`UPDATE tenants SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, id);
  return findTenantById(id);
}

export function setRelayEnabled(id: number, enabled: boolean): Tenant | null {
  getDb()
    .prepare(
      `UPDATE tenants SET relay_enabled = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(enabled ? 1 : 0, id);
  return findTenantById(id);
}

export function canRelay(tenant: Tenant, session: SessionInfo | null): boolean {
  return (
    tenant.status === 'approved' &&
    tenant.relayEnabled &&
    session != null &&
    session.status === 'active'
  );
}

export function getSession(tenantId: number): SessionInfo | null {
  const row = getDb()
    .prepare('SELECT * FROM sessions WHERE tenant_id = ?')
    .get(tenantId) as
    | {
        tenant_id: number;
        session_path: string | null;
        zalo_own_id: string | null;
        status: SessionStatus;
        last_error: string | null;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    sessionPath: row.session_path,
    zaloOwnId: row.zalo_own_id,
    status: row.status,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export function upsertSession(
  tenantId: number,
  patch: {
    sessionPath?: string | null;
    zaloOwnId?: string | null;
    status?: SessionStatus;
    lastError?: string | null;
  },
): SessionInfo {
  const current = getSession(tenantId);
  if (!current) {
    getDb()
      .prepare(
        `INSERT INTO sessions (tenant_id, session_path, zalo_own_id, status, last_error)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        tenantId,
        patch.sessionPath ?? null,
        patch.zaloOwnId ?? null,
        patch.status ?? 'none',
        patch.lastError ?? null,
      );
  } else {
    getDb()
      .prepare(
        `UPDATE sessions SET
           session_path = COALESCE(?, session_path),
           zalo_own_id = COALESCE(?, zalo_own_id),
           status = COALESCE(?, status),
           last_error = ?,
           updated_at = datetime('now')
         WHERE tenant_id = ?`,
      )
      .run(
        patch.sessionPath !== undefined ? patch.sessionPath : null,
        patch.zaloOwnId !== undefined ? patch.zaloOwnId : null,
        patch.status ?? null,
        patch.lastError !== undefined ? patch.lastError : current.lastError,
        tenantId,
      );
  }
  return getSession(tenantId)!;
}

export function clearSession(tenantId: number): void {
  getDb()
    .prepare(
      `UPDATE sessions SET
         session_path = NULL,
         zalo_own_id = NULL,
         status = 'none',
         last_error = NULL,
         updated_at = datetime('now')
       WHERE tenant_id = ?`,
    )
    .run(tenantId);
}

export function listRelayReadyTenants(): Array<{ tenant: Tenant; session: SessionInfo }> {
  const tenants = listTenants('approved').filter((t) => t.relayEnabled);
  const out: Array<{ tenant: Tenant; session: SessionInfo }> = [];
  for (const tenant of tenants) {
    const session = getSession(tenant.id);
    if (session?.status === 'active' && session.sessionPath) {
      out.push({ tenant, session });
    }
  }
  return out;
}
