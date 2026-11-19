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

  it('does not match đồng inside đồng thời', () => {
    expect(matchesKeywords('đồng thời thiết lập SL', ['đồng'])).toBe(false);
    expect(matchesKeywords('Đồng micro tháng 3', ['đồng'])).toBe(true);
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

  it('signal wheat does not match kim loại keywords via đồng thời', () => {
    const r = rule({
      filterMode: 'keywords',
      keywords: ['bạc', 'bạch kim', 'mhg', 'ple', 'sil', 'đồng'],
    });
    const wheat = `🔔 [CHỜ BÁN] LÚA MỲ THÁNG 3 (ZWAH27)

🔸 Giá chờ bán (Sell Limit): 590.30
🛑 Dừng lỗ: 597.10
🎯 Chốt lời: 571.26

📌 A/C tiến hành đặt lệnh Sell Limit theo mức giá trên, đồng thời thiết lập Dừng lỗ và Chốt lời tương ứng nhé ạ`;
    expect(ruleMatchesContent(r, wheat)).toBe(false);
  });

  it('signal copper still matches đồng / mhg', () => {
    const r = rule({
      filterMode: 'keywords',
      keywords: ['bạc', 'bạch kim', 'mhg', 'ple', 'sil', 'đồng'],
    });
    const copper = `🔔 [CHỜ MUA] ĐỒNG MICRO T3 (MHGH27)

🟢 Giá chờ mua (Buy Limit): 602.15
🛑 Dừng lỗ: 590.00
🎯 Chốt lời: 620.00

📌 A/C tiến hành đặt lệnh Buy Limit theo mức giá trên, đồng thời thiết lập Dừng lỗ và Chốt lời tương ứng nhé ạ`;
    expect(ruleMatchesContent(r, copper)).toBe(true);
  });
});
