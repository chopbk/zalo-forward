import { describe, expect, it } from 'vitest';
import { parseCommaIds, takeLeadingIds } from '../src/telegram/parse-ids.js';

describe('parseCommaIds', () => {
  it('splits and dedupes', () => {
    expect(parseCommaIds('111, 222,111')).toEqual(['111', '222']);
  });
});

describe('takeLeadingIds', () => {
  it('parses batch then flags', () => {
    expect(takeLeadingIds(['111,222', 'group', 'readonly'])).toEqual({
      ids: ['111', '222'],
      rest: ['group', 'readonly'],
    });
  });

  it('parses single id with name', () => {
    expect(takeLeadingIds(['9045', 'readonly', 'My', 'Group'])).toEqual({
      ids: ['9045'],
      rest: ['readonly', 'My', 'Group'],
    });
  });
});
