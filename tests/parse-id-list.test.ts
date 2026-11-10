import { describe, expect, it } from 'vitest';
import { parseIdList } from '../src/config/env.js';

describe('parseIdList', () => {
  it('parses comma and whitespace', () => {
    expect(parseIdList('a, b;c\nd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('dedups', () => {
    expect(parseIdList('1,1,2')).toEqual(['1', '2']);
  });
});
