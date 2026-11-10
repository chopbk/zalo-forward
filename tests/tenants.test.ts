import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';
import { closeDb, getDb } from '../src/db/client.js';
import {
  canRelay,
  createOrGetPending,
  getSession,
  setRelayEnabled,
  setTenantStatus,
  upsertSession,
} from '../src/db/tenants.js';
import {
  createRule,
  deleteRule,
  listEnabledRulesForSource,
  listRulesForSource,
  ruleMatchesContent,
  upsertRuleBySource,
} from '../src/db/rules.js';
import { claimProcessedMessage } from '../src/db/processed.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zmf-test-'));
  process.env.ZALO_BOT_TOKEN = 'test-token';
  process.env.ADMIN_SETUP_PASSWORD = 'secret-admin';
  process.env.ADMIN_ZALO_USER_IDS = '';
  process.env.DATABASE_PATH = join(dir, 'test.db');
  process.env.ZALO_BOT_TRANSPORT = 'polling';
  resetEnvCache();
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  resetEnvCache();
  rmSync(dir, { recursive: true, force: true });
});

describe('tenant gate', () => {
  it('pending cannot relay', () => {
    const { tenant } = createOrGetPending('u1', 'User');
    const session = upsertSession(tenant.id, {
      status: 'active',
      sessionPath: '/tmp/x.json',
      zaloOwnId: 'own',
    });
    expect(canRelay(tenant, session)).toBe(false);
  });

  it('approved + active + relay on can relay', () => {
    const { tenant } = createOrGetPending('u2', 'User');
    setTenantStatus(tenant.id, 'approved');
    const updated = setRelayEnabled(tenant.id, true)!;
    const session = upsertSession(updated.id, {
      status: 'active',
      sessionPath: '/tmp/x.json',
    });
    expect(canRelay(updated, session)).toBe(true);
  });

  it('pause disables relay', () => {
    const { tenant } = createOrGetPending('u3', 'User');
    setTenantStatus(tenant.id, 'approved');
    const paused = setRelayEnabled(tenant.id, false)!;
    const session = getSession(paused.id);
    upsertSession(paused.id, { status: 'active', sessionPath: '/x' });
    expect(canRelay(paused, getSession(paused.id))).toBe(false);
    void session;
  });
});

describe('rules + dedup', () => {
  it('creates rule and matches', () => {
    const { tenant } = createOrGetPending('u4', 'User');
    setTenantStatus(tenant.id, 'approved');
    const rule = createRule({
      tenantId: tenant.id,
      sourceGroupId: 'G1',
      targets: ['G2', 'G3'],
      filterMode: 'keywords',
      keywords: ['vip'],
    });
    expect(rule.targets).toEqual(['G2', 'G3']);
    const enabled = listEnabledRulesForSource(tenant.id, 'G1');
    expect(enabled).toHaveLength(1);
    expect(ruleMatchesContent(enabled[0]!, 'tin vip')).toBe(true);
    expect(ruleMatchesContent(enabled[0]!, 'thường')).toBe(false);
  });

  it('dedup claim once', () => {
    expect(claimProcessedMessage(1, 'm1')).toBe(true);
    expect(claimProcessedMessage(1, 'm1')).toBe(false);
  });

  it('upserts by source instead of duplicating', () => {
    const { tenant } = createOrGetPending('u5', 'User');
    setTenantStatus(tenant.id, 'approved');
    const first = upsertRuleBySource({
      tenantId: tenant.id,
      sourceGroupId: 'A',
      targets: ['B'],
      filterMode: 'all',
    });
    expect(first.created).toBe(true);
    createRule({
      tenantId: tenant.id,
      sourceGroupId: 'A',
      targets: ['X'],
      filterMode: 'all',
    });
    expect(listRulesForSource(tenant.id, 'A')).toHaveLength(2);

    const second = upsertRuleBySource({
      tenantId: tenant.id,
      sourceGroupId: 'A',
      targets: ['B', 'C'],
      filterMode: 'all',
    });
    expect(second.created).toBe(false);
    expect(second.rule.id).toBe(first.rule.id);
    expect(second.rule.targets).toEqual(['B', 'C']);
    expect(second.removedIds.length).toBeGreaterThan(0);
    expect(listRulesForSource(tenant.id, 'A')).toHaveLength(1);
  });

  it('reuses deleted rule id', () => {
    const { tenant } = createOrGetPending('u6', 'User');
    setTenantStatus(tenant.id, 'approved');
    const a = createRule({
      tenantId: tenant.id,
      sourceGroupId: 'S1',
      targets: ['D1'],
      filterMode: 'all',
    });
    const b = createRule({
      tenantId: tenant.id,
      sourceGroupId: 'S2',
      targets: ['D2'],
      filterMode: 'all',
    });
    const c = createRule({
      tenantId: tenant.id,
      sourceGroupId: 'S3',
      targets: ['D3'],
      filterMode: 'all',
    });
    expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
    deleteRule(2);
    const reused = createRule({
      tenantId: tenant.id,
      sourceGroupId: 'S4',
      targets: ['D4'],
      filterMode: 'all',
    });
    expect(reused.id).toBe(2);
  });
});
