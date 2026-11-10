import type { ForwardRule } from '../db/rules.js';
import { ruleMatchesContent } from '../db/rules.js';

export type MatchResult = {
  rule: ForwardRule;
  destGroupIds: string[];
};

/**
 * Chọn destinations từ các rule enabled khớp nguồn + filter.
 * Loại dest trùng source; gộp unique.
 */
export function resolveDestinations(
  rules: ForwardRule[],
  sourceGroupId: string,
  text: string,
): MatchResult[] {
  const results: MatchResult[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.sourceGroupId !== sourceGroupId) continue;
    if (!ruleMatchesContent(rule, text)) continue;
    const dests = [...new Set(rule.targets)].filter((d) => d && d !== sourceGroupId);
    if (dests.length === 0) continue;
    results.push({ rule, destGroupIds: dests });
  }
  return results;
}

/** Phát hiện chu trình đơn giản A→B và B→A trong danh sách rule của tenant */
export function detectSimpleCycles(
  rules: Array<{ sourceGroupId: string; targets: string[] }>,
): string[] {
  const warnings: string[] = [];
  const edges = new Map<string, Set<string>>();
  for (const r of rules) {
    if (!edges.has(r.sourceGroupId)) edges.set(r.sourceGroupId, new Set());
    for (const t of r.targets) {
      edges.get(r.sourceGroupId)!.add(t);
    }
  }
  for (const [a, targets] of edges) {
    for (const b of targets) {
      if (edges.get(b)?.has(a)) {
        warnings.push(`${a} ↔ ${b}`);
      }
    }
  }
  return [...new Set(warnings)];
}
