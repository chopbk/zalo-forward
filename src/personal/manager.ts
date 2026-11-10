import logger from '../config/logger.js';
import {
  clearSession,
  getSession,
  listRelayReadyTenants,
  upsertSession,
  type Tenant,
} from '../db/tenants.js';
import { upsertGroupCache } from '../db/rules.js';
import { deleteSessionFile } from './session.js';
import { loginWithSession } from './session.js';
import { PersonalAccountAdapter } from './adapter.js';
import type { NormalizedGroupMessage } from '../relay/normalize.js';

export type RelayInboundHandler = (
  tenant: Tenant,
  msg: NormalizedGroupMessage,
) => void | Promise<void>;

type Slot = {
  tenant: Tenant;
  adapter: PersonalAccountAdapter;
};

/**
 * Multi-tenant personal Zalo session supervisor.
 */
export class SessionManager {
  private readonly slots = new Map<number, Slot>();
  private inboundHandler: RelayInboundHandler | null = null;

  onInbound(handler: RelayInboundHandler): void {
    this.inboundHandler = handler;
  }

  getAdapter(tenantId: number): PersonalAccountAdapter | null {
    return this.slots.get(tenantId)?.adapter ?? null;
  }

  isRunning(tenantId: number): boolean {
    return this.slots.has(tenantId);
  }

  async startAllReady(): Promise<void> {
    const ready = listRelayReadyTenants();
    for (const { tenant, session } of ready) {
      try {
        await this.startTenant(tenant, session.sessionPath!);
      } catch (err) {
        logger.error({ err, tenantId: tenant.id }, 'Failed to start tenant session');
        upsertSession(tenant.id, {
          status: 'error',
          lastError: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async startTenant(tenant: Tenant, sessionPath: string): Promise<void> {
    if (this.slots.has(tenant.id)) {
      await this.stopTenant(tenant.id);
    }
    if (tenant.status !== 'approved' || !tenant.relayEnabled) {
      logger.info({ tenantId: tenant.id }, 'Skip start — not approved/enabled');
      return;
    }

    const api = await loginWithSession(sessionPath);
    const adapter = new PersonalAccountAdapter(tenant.id, api, sessionPath);
    adapter.onGroupMessage(async (msg) => {
      if (!this.inboundHandler) return;
      await this.inboundHandler(tenant, msg);
    });
    adapter.start();

    try {
      const groups = await adapter.listGroups();
      for (const g of groups) {
        upsertGroupCache(tenant.id, g.groupId, g.name);
      }
    } catch (err) {
      logger.warn({ err, tenantId: tenant.id }, 'Sync groups failed');
    }

    upsertSession(tenant.id, {
      sessionPath,
      zaloOwnId: adapter.getOwnId(),
      status: 'active',
      lastError: null,
    });

    this.slots.set(tenant.id, { tenant, adapter });
    logger.info({ tenantId: tenant.id, ownId: adapter.getOwnId() }, 'Tenant session running');
  }

  async stopTenant(tenantId: number): Promise<void> {
    const slot = this.slots.get(tenantId);
    if (!slot) return;
    slot.adapter.stop();
    this.slots.delete(tenantId);
    logger.info({ tenantId }, 'Tenant session stopped');
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.slots.keys()]) {
      await this.stopTenant(id);
    }
  }

  async logoutTenant(tenantId: number): Promise<void> {
    await this.stopTenant(tenantId);
    const session = getSession(tenantId);
    if (session?.sessionPath) {
      await deleteSessionFile(session.sessionPath);
    }
    clearSession(tenantId);
  }

  async refreshGroups(
    tenantId: number,
  ): Promise<Array<{ groupId: string; name: string; lastActiveAt?: number }>> {
    const adapter = this.getAdapter(tenantId);
    if (!adapter) throw new Error('Session chưa chạy — /login rồi /resume');
    const groups = await adapter.listGroups();
    const now = Date.now();
    groups.forEach((g, i) => {
      // Giữ ts thật; group chưa có activity giữ thứ tự sort bằng ts giả giảm dần
      const ts = g.lastActiveAt && g.lastActiveAt > 0 ? g.lastActiveAt : now - i;
      upsertGroupCache(tenantId, g.groupId, g.name, ts);
    });
    return groups;
  }
}

export const sessionManager = new SessionManager();
