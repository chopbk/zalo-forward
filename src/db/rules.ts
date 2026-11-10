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

  const info = getDb()
    .prepare(
      `INSERT INTO forward_rules (tenant_id, source_group_id, filter_mode, include_updates)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.tenantId,
      input.sourceGroupId,
      input.filterMode,
      input.includeUpdates ? 1 : 0,
    );

  const ruleId = Number(info.lastInsertRowid);
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

export function upsertGroupCache(
  tenantId: number,
  groupId: string,
  name: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO groups_cache (tenant_id, group_id, name, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, group_id) DO UPDATE SET
         name = COALESCE(excluded.name, groups_cache.name),
         last_seen_at = excluded.last_seen_at`,
    )
    .run(tenantId, groupId, name, Date.now());
}

export function listGroupCache(tenantId: number): Array<{ groupId: string; name: string | null }> {
  const rows = getDb()
    .prepare(
      `SELECT group_id, name FROM groups_cache WHERE tenant_id = ? ORDER BY name COLLATE NOCASE`,
    )
    .all(tenantId) as Array<{ group_id: string; name: string | null }>;
  return rows.map((r) => ({ groupId: r.group_id, name: r.name }));
}

export function getGroupName(tenantId: number, groupId: string): string | null {
  const row = getDb()
    .prepare(`SELECT name FROM groups_cache WHERE tenant_id = ? AND group_id = ?`)
    .get(tenantId, groupId) as { name: string | null } | undefined;
  return row?.name ?? null;
}
