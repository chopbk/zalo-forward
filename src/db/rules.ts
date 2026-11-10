import { getDb, type FilterMode, type ForwardRuleRow } from './client.js';

export type ForwardRule = {
  id: number;
  tenantId: number;
  sourceGroupId: string;
  filterMode: FilterMode;
  enabled: boolean;
  includeUpdates: boolean;
  targets: string[];
  keywords: string[];
  createdAt: string;
  updatedAt: string;
};

function mapRule(row: ForwardRuleRow, targets: string[], keywords: string[]): ForwardRule {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sourceGroupId: row.source_group_id,
    filterMode: row.filter_mode,
    enabled: row.enabled === 1,
    includeUpdates: row.include_updates === 1,
    targets,
    keywords,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function loadTargets(ruleId: number): string[] {
  const rows = getDb()
    .prepare('SELECT dest_group_id FROM rule_targets WHERE rule_id = ? ORDER BY dest_group_id')
    .all(ruleId) as Array<{ dest_group_id: string }>;
  return rows.map((r) => r.dest_group_id);
}

function loadKeywords(ruleId: number): string[] {
  const rows = getDb()
    .prepare('SELECT keyword FROM rule_keywords WHERE rule_id = ? ORDER BY keyword')
    .all(ruleId) as Array<{ keyword: string }>;
  return rows.map((r) => r.keyword);
}

export function getRule(id: number): ForwardRule | null {
  const row = getDb()
    .prepare('SELECT * FROM forward_rules WHERE id = ?')
    .get(id) as ForwardRuleRow | undefined;
  if (!row) return null;
  return mapRule(row, loadTargets(id), loadKeywords(id));
}

export function listRules(tenantId: number): ForwardRule[] {
  const rows = getDb()
    .prepare('SELECT * FROM forward_rules WHERE tenant_id = ? ORDER BY id ASC')
    .all(tenantId) as ForwardRuleRow[];
  return rows.map((r) => mapRule(r, loadTargets(r.id), loadKeywords(r.id)));
}

export function listEnabledRulesForSource(
  tenantId: number,
  sourceGroupId: string,
): ForwardRule[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM forward_rules
       WHERE tenant_id = ? AND source_group_id = ? AND enabled = 1`,
    )
    .all(tenantId, sourceGroupId) as ForwardRuleRow[];
  return rows.map((r) => mapRule(r, loadTargets(r.id), loadKeywords(r.id)));
}

/** Id luật trống nhỏ nhất (1,2,3…), tái dùng chỗ vừa /rules del. */
export function nextAvailableRuleId(): number {
  const rows = getDb()
    .prepare(`SELECT id FROM forward_rules ORDER BY id ASC`)
    .all() as Array<{ id: number }>;
  let expect = 1;
  for (const row of rows) {
    if (row.id > expect) return expect;
    expect = row.id + 1;
  }
  return expect;
}

export function createRule(input: {
  tenantId: number;
  sourceGroupId: string;
  targets: string[];
  filterMode: FilterMode;
  keywords?: string[];
  includeUpdates?: boolean;
}): ForwardRule {
  const targets = [...new Set(input.targets.map(String))].filter(
    (id) => id && id !== input.sourceGroupId,
  );
  if (targets.length === 0) {
    throw new Error('Cần ít nhất 1 group đích khác group nguồn');
  }

  const keywords =
    input.filterMode === 'keywords'
      ? [...new Set((input.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean))]
      : [];
  if (input.filterMode === 'keywords' && keywords.length === 0) {
    throw new Error('Chế độ từ khóa cần ít nhất 1 keyword');
  }

  const ruleId = nextAvailableRuleId();
  getDb()
    .prepare(
      `INSERT INTO forward_rules (id, tenant_id, source_group_id, filter_mode, include_updates)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      ruleId,
      input.tenantId,
      input.sourceGroupId,
      input.filterMode,
      input.includeUpdates ? 1 : 0,
    );

  const insertTarget = getDb().prepare(
    `INSERT INTO rule_targets (rule_id, dest_group_id) VALUES (?, ?)`,
  );
  for (const dest of targets) {
    insertTarget.run(ruleId, dest);
  }
  const insertKw = getDb().prepare(
    `INSERT INTO rule_keywords (rule_id, keyword) VALUES (?, ?)`,
  );
  for (const kw of keywords) {
    insertKw.run(ruleId, kw);
  }

  return getRule(ruleId)!;
}

export function setRuleEnabled(ruleId: number, enabled: boolean): ForwardRule | null {
  getDb()
    .prepare(
      `UPDATE forward_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(enabled ? 1 : 0, ruleId);
  return getRule(ruleId);
}

/** Thay toàn bộ đích + chế độ lọc của luật (sửa luật cũ). */
export function updateRule(
  ruleId: number,
  input: {
    targets: string[];
    filterMode: FilterMode;
    keywords?: string[];
  },
): ForwardRule | null {
  const existing = getRule(ruleId);
  if (!existing) return null;

  const targets = [...new Set(input.targets.map(String))].filter(
    (id) => id && id !== existing.sourceGroupId,
  );
  if (targets.length === 0) {
    throw new Error('Cần ít nhất 1 group đích khác group nguồn');
  }

  const keywords =
    input.filterMode === 'keywords'
      ? [...new Set((input.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean))]
      : [];
  if (input.filterMode === 'keywords' && keywords.length === 0) {
    throw new Error('Chế độ từ khóa cần ít nhất 1 keyword');
  }

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE forward_rules
       SET filter_mode = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(input.filterMode, ruleId);
    db.prepare(`DELETE FROM rule_targets WHERE rule_id = ?`).run(ruleId);
    db.prepare(`DELETE FROM rule_keywords WHERE rule_id = ?`).run(ruleId);
    const insertTarget = db.prepare(
      `INSERT INTO rule_targets (rule_id, dest_group_id) VALUES (?, ?)`,
    );
    for (const dest of targets) {
      insertTarget.run(ruleId, dest);
    }
    if (input.filterMode === 'keywords') {
      const insertKw = db.prepare(
        `INSERT INTO rule_keywords (rule_id, keyword) VALUES (?, ?)`,
      );
      for (const kw of keywords) {
        insertKw.run(ruleId, kw);
      }
    }
  });
  tx();
  return getRule(ruleId);
}

export function listRulesForSource(
  tenantId: number,
  sourceGroupId: string,
): ForwardRule[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM forward_rules
       WHERE tenant_id = ? AND source_group_id = ?
       ORDER BY id ASC`,
    )
    .all(tenantId, sourceGroupId) as ForwardRuleRow[];
  return rows.map((r) => mapRule(r, loadTargets(r.id), loadKeywords(r.id)));
}

/**
 * Cùng nguồn → sửa luật cũ (id nhỏ nhất). Luật trùng nguồn còn lại bị xóa.
 * Chưa có → tạo mới.
 */
export function upsertRuleBySource(input: {
  tenantId: number;
  sourceGroupId: string;
  targets: string[];
  filterMode: FilterMode;
  keywords?: string[];
  includeUpdates?: boolean;
}): { rule: ForwardRule; created: boolean; removedIds: number[] } {
  const existing = listRulesForSource(input.tenantId, input.sourceGroupId);
  if (existing.length === 0) {
    return {
      rule: createRule(input),
      created: true,
      removedIds: [],
    };
  }

  const keep = existing[0]!;
  const removedIds: number[] = [];
  for (const extra of existing.slice(1)) {
    deleteRule(extra.id);
    removedIds.push(extra.id);
  }

  const updated = updateRule(keep.id, {
    targets: input.targets,
    filterMode: input.filterMode,
    keywords: input.keywords,
  });
  if (!updated) {
    throw new Error(`Không cập nhật được luật #${keep.id}`);
  }

  if (input.includeUpdates != null) {
    getDb()
      .prepare(
        `UPDATE forward_rules
         SET include_updates = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(input.includeUpdates ? 1 : 0, keep.id);
  }

  // Bật lại nếu luật cũ đang tắt — /addrule coi như muốn chạy.
  if (!updated.enabled) {
    setRuleEnabled(keep.id, true);
  }

  return {
    rule: getRule(keep.id)!,
    created: false,
    removedIds,
  };
}

export function deleteRule(ruleId: number): boolean {
  const info = getDb().prepare('DELETE FROM forward_rules WHERE id = ?').run(ruleId);
  return info.changes > 0;
}

export function addKeywords(ruleId: number, keywords: string[]): ForwardRule | null {
  const rule = getRule(ruleId);
  if (!rule) return null;
  const insert = getDb().prepare(
    `INSERT OR IGNORE INTO rule_keywords (rule_id, keyword) VALUES (?, ?)`,
  );
  for (const raw of keywords) {
    const kw = raw.trim().toLowerCase();
    if (kw) insert.run(ruleId, kw);
  }
  if (rule.filterMode !== 'keywords') {
    getDb()
      .prepare(
        `UPDATE forward_rules SET filter_mode = 'keywords', updated_at = datetime('now') WHERE id = ?`,
      )
      .run(ruleId);
  }
  return getRule(ruleId);
}

export function removeKeyword(ruleId: number, keyword: string): ForwardRule | null {
  getDb()
    .prepare(`DELETE FROM rule_keywords WHERE rule_id = ? AND keyword = ?`)
    .run(ruleId, keyword.trim().toLowerCase());
  return getRule(ruleId);
}

/** Substring match, case-insensitive */
export function matchesKeywords(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const hay = text.toLowerCase();
  return keywords.some((kw) => hay.includes(kw.toLowerCase()));
}

export function ruleMatchesContent(rule: ForwardRule, text: string): boolean {
  if (rule.filterMode === 'all') return true;
  return matchesKeywords(text, rule.keywords);
}

/**
 * Đồng bộ tên group. Không đè last_seen_at trừ khi truyền lastSeenAt (ms).
 */
export function upsertGroupCache(
  tenantId: number,
  groupId: string,
  name: string | null,
  lastSeenAt?: number,
): void {
  if (lastSeenAt != null && lastSeenAt > 0) {
    getDb()
      .prepare(
        `INSERT INTO groups_cache (tenant_id, group_id, name, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, group_id) DO UPDATE SET
           name = COALESCE(excluded.name, groups_cache.name),
           last_seen_at = MAX(groups_cache.last_seen_at, excluded.last_seen_at)`,
      )
      .run(tenantId, groupId, name, lastSeenAt);
    return;
  }

  getDb()
    .prepare(
      `INSERT INTO groups_cache (tenant_id, group_id, name, last_seen_at)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(tenant_id, group_id) DO UPDATE SET
         name = COALESCE(excluded.name, groups_cache.name)`,
    )
    .run(tenantId, groupId, name);
}

/** Cập nhật hoạt động gần đây (tin inbound / unread mark). */
export function touchGroupActivity(
  tenantId: number,
  groupId: string,
  atMs: number = Date.now(),
  name?: string | null,
): void {
  upsertGroupCache(tenantId, groupId, name ?? null, atMs);
}

/** Ghi đè last_seen_at (dùng sau probe /groups — không MAX với timestamp giả cũ). */
export function setGroupLastSeen(
  tenantId: number,
  groupId: string,
  name: string | null,
  lastSeenAt: number,
): void {
  if (!(lastSeenAt > 0)) {
    upsertGroupCache(tenantId, groupId, name);
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO groups_cache (tenant_id, group_id, name, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, group_id) DO UPDATE SET
         name = COALESCE(excluded.name, groups_cache.name),
         last_seen_at = excluded.last_seen_at`,
    )
    .run(tenantId, groupId, name, lastSeenAt);
}

export function listGroupCache(
  tenantId: number,
): Array<{ groupId: string; name: string | null; lastSeenAt: number }> {
  const rows = getDb()
    .prepare(
      `SELECT group_id, name, last_seen_at FROM groups_cache
       WHERE tenant_id = ?
       ORDER BY last_seen_at DESC, name COLLATE NOCASE ASC`,
    )
    .all(tenantId) as Array<{
    group_id: string;
    name: string | null;
    last_seen_at: number;
  }>;
  return rows.map((r) => ({
    groupId: r.group_id,
    name: r.name,
    lastSeenAt: r.last_seen_at ?? 0,
  }));
}

/** Map groupId → last_seen_at (ms) đã biết từ inbound / lần /groups trước. */
export function getGroupActivityMap(tenantId: number): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT group_id, last_seen_at FROM groups_cache
       WHERE tenant_id = ? AND last_seen_at > 0`,
    )
    .all(tenantId) as Array<{ group_id: string; last_seen_at: number }>;
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.group_id, row.last_seen_at);
  }
  return map;
}

export function getGroupName(tenantId: number, groupId: string): string | null {
  const row = getDb()
    .prepare(`SELECT name FROM groups_cache WHERE tenant_id = ? AND group_id = ?`)
    .get(tenantId, groupId) as { name: string | null } | undefined;
  return row?.name ?? null;
}
