import { describe, expect, it } from 'vitest';
import { matchesKeywords, ruleMatchesContent } from '../src/db/rules.js';
import type { ForwardRule } from '../src/db/rules.js';

function rule(partial: Partial<ForwardRule> & Pick<ForwardRule, 'filterMode' | 'keywords'>): ForwardRule {
  return {
    id: 1,
    tenantId: 1,
    sourceGroupId: 'A',
    enabled: true,
    includeUpdates: false,
    targets: ['B'],
    createdAt: '',
    updatedAt: '',
    ...partial,
  };
}

describe('matchesKeywords', () => {
  it('matches substring case-insensitive', () => {
    expect(matchesKeywords('Flash SALE hôm nay', ['sale'])).toBe(true);
    expect(matchesKeywords('hello', ['sale'])).toBe(false);
  });

  it('needs at least one keyword', () => {
    expect(matchesKeywords('anything', [])).toBe(false);
  });
});

describe('ruleMatchesContent', () => {
  it('all mode always passes', () => {
    expect(ruleMatchesContent(rule({ filterMode: 'all', keywords: [] }), 'x')).toBe(true);
  });

  it('keywords mode filters', () => {
    const r = rule({ filterMode: 'keywords', keywords: ['hot', 'deal'] });
    expect(ruleMatchesContent(r, 'siêu hot')).toBe(true);
    expect(ruleMatchesContent(r, 'bình thường')).toBe(false);
  });
});
