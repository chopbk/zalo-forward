import { describe, expect, it } from 'vitest';
import { parseGroupMessage } from '../src/relay/normalize.js';
import {
  clipStylesToText,
  extractStylesFromParams,
  extractStylesFromPropertyExt,
  offsetStyles,
} from '../src/relay/styles.js';

describe('styles', () => {
  it('parses styles from propertyExt.ext', () => {
    const styles = extractStylesFromPropertyExt({
      ext: JSON.stringify({
        styles: [
          { start: 0, len: 4, st: 'b' },
          { start: 5, len: 3, st: 'c_db342e' },
          { start: 9, len: 2, st: 'ind_20' },
        ],
        ver: 0,
      }),
    });
    expect(styles).toEqual([
      { start: 0, len: 4, st: 'b' },
      { start: 5, len: 3, st: 'c_db342e' },
      { start: 9, len: 2, st: 'ind_$', indentSize: 2 },
    ]);
  });

  it('splits combined RTF st codes', () => {
    const styles = extractStylesFromParams(
      JSON.stringify({
        styles: [
          { start: 0, len: 0, st: 'b,c_db342e' },
          { start: 2, len: 10, st: 'b,c_db342e' },
        ],
        ver: 0,
      }),
    );
    expect(styles).toEqual([
      { start: 2, len: 10, st: 'b' },
      { start: 2, len: 10, st: 'c_db342e' },
    ]);
  });

  it('offsets and clips styles', () => {
    const offset = offsetStyles([{ start: 0, len: 3, st: 'b' }], 5);
    expect(offset[0]).toEqual({ start: 5, len: 3, st: 'b' });
    expect(clipStylesToText(offset, 'xxxxxabc')).toHaveLength(1);
    expect(clipStylesToText(offset, 'short')).toHaveLength(0);
  });

  it('keeps styles on plain text inbound', () => {
    const msg = parseGroupMessage({
      threadId: 'G1',
      isSelf: false,
      data: {
        content: 'Hello bold',
        msgId: 1,
        dName: 'A',
        propertyExt: {
          ext: JSON.stringify({
            styles: [{ start: 6, len: 4, st: 'b' }],
            ver: 0,
          }),
        },
      },
    });
    expect(msg?.styles).toEqual([{ start: 6, len: 4, st: 'b' }]);
  });

  it('parses RTF content.action=rtf with styles in params', () => {
    const title =
      '📍Anh/Chị vui lòng dành 1 phút hoàn thành FORM KHẢO SÁT';
    const msg = parseGroupMessage({
      threadId: 'G1',
      isSelf: false,
      data: {
        msgId: 99,
        msgType: 'webchat',
        dName: 'A',
        content: {
          title,
          description: '',
          href: '',
          thumb: '',
          action: 'rtf',
          params: JSON.stringify({
            styles: [
              { start: 2, len: 10, st: 'b,c_db342e' },
              { start: 20, len: 5, st: 'b' },
            ],
            ver: 0,
          }),
        },
      },
    });
    expect(msg?.text).toBe(title);
    expect(msg?.styles).toEqual([
      { start: 2, len: 10, st: 'b' },
      { start: 2, len: 10, st: 'c_db342e' },
      { start: 20, len: 5, st: 'b' },
    ]);
  });
});
