import { describe, expect, it } from 'vitest';
import {
  extractLinkAttachment,
  formatLinkText,
  parseGroupMessage,
} from '../src/relay/normalize.js';

describe('normalize', () => {
  it('parses plain text', () => {
    const msg = parseGroupMessage({
      threadId: 'G1',
      isSelf: false,
      data: { content: 'hello', msgId: 99, dName: 'A' },
    });
    expect(msg).toMatchObject({
      groupId: 'G1',
      text: 'hello',
      messageId: '99',
      senderName: 'A',
    });
  });

  it('formats link', () => {
    const link = extractLinkAttachment(
      { href: 'https://example.com', title: 'Example', description: 'desc' },
      'chat.share',
    );
    expect(link?.href).toBe('https://example.com');
    expect(formatLinkText(link!)).toContain('Example');
    expect(formatLinkText(link!)).toContain('https://example.com');
  });

  it('falls back for unsupported object content', () => {
    const msg = parseGroupMessage({
      threadId: 'G1',
      isSelf: false,
      data: {
        content: { foo: 1 },
        msgType: 'chat.sticker',
        msgId: 7,
        dName: 'B',
      },
    });
    expect(msg?.text).toContain('sticker');
    expect(msg?.senderName).toBe('B');
  });
});
