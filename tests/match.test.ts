import { describe, expect, it } from 'vitest';
import { detectSimpleCycles, resolveDestinations } from '../src/relay/match.js';
import type { ForwardRule } from '../src/db/rules.js';

function makeRule(over: Partial<ForwardRule> & Pick<ForwardRule, 'sourceGroupId' | 'targets' | 'filterMode'>): ForwardRule {
  return {
    id: over.id ?? 1,
    tenantId: 1,
    enabled: over.enabled ?? true,
    includeUpdates: false,
    keywords: over.keywords ?? [],
    createdAt: '',
    updatedAt: '',
    sourceGroupId: over.sourceGroupId,
    targets: over.targets,
    filterMode: over.filterMode,
  };
}

describe('resolveDestinations', () => {
  it('fans out unique dests and skips source', () => {
    const rules = [
      makeRule({
        id: 1,
        sourceGroupId: 'A',
        targets: ['B', 'C', 'A'],
        filterMode: 'all',
      }),
      makeRule({
        id: 2,
        sourceGroupId: 'A',
        targets: ['C', 'D'],
        filterMode: 'all',
      }),
    ];
    const matched = resolveDestinations(rules, 'A', 'hello');
    expect(matched).toHaveLength(2);
    expect(matched[0]!.destGroupIds).toEqual(['B', 'C']);
    expect(matched[1]!.destGroupIds).toEqual(['C', 'D']);
  });

  it('keyword filter anti-match skips rule', () => {
    const rules = [
      makeRule({
        sourceGroupId: 'A',
        targets: ['B'],
        filterMode: 'keywords',
        keywords: ['sale'],
      }),
    ];
    expect(resolveDestinations(rules, 'A', 'xin chào')).toHaveLength(0);
    expect(resolveDestinations(rules, 'A', 'flash sale')).toHaveLength(1);
  });
});

describe('detectSimpleCycles', () => {
  it('detects A↔B', () => {
    const warnings = detectSimpleCycles([
      { sourceGroupId: 'A', targets: ['B'] },
      { sourceGroupId: 'B', targets: ['A'] },
    ]);
    expect(warnings.some((w) => w.includes('A') && w.includes('B'))).toBe(true);
  });

  it('no cycle', () => {
    expect(
      detectSimpleCycles([
        { sourceGroupId: 'A', targets: ['B'] },
        { sourceGroupId: 'B', targets: ['C'] },
      ]),
    ).toHaveLength(0);
  });
});
