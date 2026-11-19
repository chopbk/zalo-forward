import { describe, expect, it } from 'vitest';
import {
  isTelegramDest,
  isTelegramTargetToken,
  parseTelegramDest,
  telegramDestKey,
} from '../src/telegram/dest.js';
import { parseAddTgCommand } from '../src/bot/parse-addtg.js';
import { zaloStylesToTelegramHtml } from '../src/telegram/format.js';

describe('telegram dest keys', () => {
  it('roundtrips topic id', () => {
    expect(telegramDestKey(42)).toBe('tg:#42');
    expect(parseTelegramDest('tg:#42')).toBe(42);
    expect(isTelegramDest('tg:#42')).toBe(true);
    expect(isTelegramDest('9045111')).toBe(false);
  });

  it('recognizes tokens', () => {
    expect(isTelegramTargetToken('tg')).toBe(true);
    expect(isTelegramTargetToken('telegram')).toBe(true);
    expect(isTelegramTargetToken('9045')).toBe(false);
  });
});

describe('parseAddTgCommand', () => {
  it('parses all', () => {
    expect(parseAddTgCommand('/addtg 111 all')).toEqual({
      sourceGroupId: '111',
      filterMode: 'all',
      keywords: [],
      inboundOnly: false,
    });
  });

  it('parses readonly', () => {
    expect(parseAddTgCommand('/addtg 111 all readonly')).toMatchObject({
      sourceGroupId: '111',
      inboundOnly: true,
    });
  });

  it('parses keywords', () => {
    expect(parseAddTgCommand('/addtg 111 keywords sale,hot')).toEqual({
      sourceGroupId: '111',
      filterMode: 'keywords',
      keywords: ['sale', 'hot'],
      inboundOnly: false,
    });
  });
});

describe('zaloStylesToTelegramHtml', () => {
  it('escapes and wraps bold', () => {
    const html = zaloStylesToTelegramHtml('ab', [{ start: 0, len: 1, st: 'b' }]);
    expect(html).toBe('<b>a</b>b');
  });

  it('escapes html chars', () => {
    expect(zaloStylesToTelegramHtml('a<b>', [])).toBe('a&lt;b&gt;');
  });
});
