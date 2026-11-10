import { describe, expect, it } from 'vitest';
import { parseAddRuleCommand, parseSetRuleArgs } from '../src/bot/parse-addrule.js';

describe('parseAddRuleCommand', () => {
  it('parses all mode', () => {
    const r = parseAddRuleCommand('/addrule 111 222,333 all');
    expect(r).toEqual({
      sourceGroupId: '111',
      targets: ['222', '333'],
      filterMode: 'all',
      keywords: [],
    });
  });

  it('defaults to all when filter omitted', () => {
    const r = parseAddRuleCommand('/addrule 111 222,333');
    expect(r).toMatchObject({ filterMode: 'all', targets: ['222', '333'] });
  });

  it('parses keywords', () => {
    const r = parseAddRuleCommand('/addrule 111 222 keywords sale,hot, giảm giá');
    expect(r).toEqual({
      sourceGroupId: '111',
      targets: ['222'],
      filterMode: 'keywords',
      keywords: ['sale', 'hot', 'giảm giá'],
    });
  });

  it('errors when keywords empty', () => {
    const r = parseAddRuleCommand('/addrule 111 222 keywords');
    expect(r).toHaveProperty('error');
  });

  it('errors when missing args', () => {
    expect(parseAddRuleCommand('/addrule')).toHaveProperty('error');
  });
});

describe('parseSetRuleArgs', () => {
  it('parses set destinations', () => {
    expect(parseSetRuleArgs('3 222,333 all')).toEqual({
      ruleId: 3,
      targets: ['222', '333'],
      filterMode: 'all',
      keywords: [],
    });
  });

  it('parses keywords mode', () => {
    expect(parseSetRuleArgs('7 222 keywords sale,hot')).toEqual({
      ruleId: 7,
      targets: ['222'],
      filterMode: 'keywords',
      keywords: ['sale', 'hot'],
    });
  });
});
