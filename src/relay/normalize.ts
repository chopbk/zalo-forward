import {
  extractMentions,
  extractStylesFromParams,
  extractStylesFromPropertyExt,
  type ForwardMention,
  type ForwardStyle,
} from './styles.js';

export type InboundImage = { url: string };

export type ExtractedLink = {
  href: string;
  title?: string;
  description?: string;
  thumb?: string;
};

export type NormalizedGroupMessage = {
  groupId: string;
  messageId: string;
  /** Timestamp tin gốc (ms hoặc giây — giữ raw number từ Zalo). */
  ts?: number;
  senderId?: string;
  senderName?: string;
  text: string;
  images: InboundImage[];
  styles: ForwardStyle[];
  mentions: ForwardMention[];
  /** propertyExt.ext thô — dùng debug / native forward. */
  propertyExtExt?: string;
  isSelf: boolean;
};

export function isPhotoMsgType(msgType?: string): boolean {
  if (!msgType) return false;
  const t = msgType.toLowerCase();
  return t === 'chat.photo' || t.includes('photo') || t === 'chat.doodle';
}

function collectUrlsFromParams(params: unknown, into: Set<string>): void {
  if (params == null) return;
  let obj: Record<string, unknown> | null = null;
  if (typeof params === 'string' && params.trim()) {
    try {
      obj = JSON.parse(params) as Record<string, unknown>;
    } catch {
      return;
    }
  } else if (typeof params === 'object') {
    obj = params as Record<string, unknown>;
  }
  if (!obj) return;
  for (const key of ['hd', 'oriUrl', 'normalUrl', 'url', 'href', 'thumbUrl']) {
    const v = obj[key];
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) into.add(v);
  }
}

export function extractInboundImages(
  content: unknown,
  msgType?: string,
): InboundImage[] | null {
  if (!content || typeof content !== 'object') return null;
  const obj = content as Record<string, unknown>;

  const hasHref = typeof obj.href === 'string' && /^https?:\/\//i.test(obj.href);
  const hasThumb =
    typeof obj.thumb === 'string' && /^https?:\/\//i.test(String(obj.thumb));

  if (msgType && !isPhotoMsgType(msgType)) return null;
  if (!msgType && !(hasHref && hasThumb)) return null;

  const urls = new Set<string>();
  collectUrlsFromParams(obj.params, urls);
  if (hasHref) urls.add(obj.href as string);
  if (urls.size === 0 && hasThumb) urls.add(String(obj.thumb));
  if (urls.size === 0) return null;

  return [{ url: [...urls][0]! }];
}

export function captionFromPhotoContent(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const obj = content as Record<string, unknown>;
  if (typeof obj.title === 'string' && obj.title.trim() && !/^https?:\/\//i.test(obj.title)) {
    return obj.title.trim();
  }
  if (typeof obj.description === 'string' && obj.description.trim()) {
    return obj.description.trim();
  }
  return '';
}

export function extractLinkAttachment(
  content: unknown,
  msgType?: string,
): ExtractedLink | null {
  if (!content || typeof content !== 'object') return null;
  if (isPhotoMsgType(msgType)) return null;
  if (msgType && /recommended/i.test(msgType)) return null;

  const obj = content as Record<string, unknown>;
  if (typeof obj.type === 'string' && obj.type.toLowerCase() === 'photo') {
    return null;
  }

  const href = typeof obj.href === 'string' ? obj.href.trim() : '';
  if (!/^https?:\/\//i.test(href)) return null;

  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const rawDesc = typeof obj.description === 'string' ? obj.description.trim() : '';
  const description =
    rawDesc && !rawDesc.startsWith('{') && !rawDesc.startsWith('[') ? rawDesc : '';

  const thumb =
    typeof obj.thumb === 'string' && /^https?:\/\//i.test(obj.thumb)
      ? obj.thumb
      : undefined;

  const looksLikeImageFile = /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(href);
  if (!title && !description && looksLikeImageFile) return null;

  return {
    href,
    title: title || undefined,
    description: description || undefined,
    thumb,
  };
}

export function formatLinkText(link: ExtractedLink): string {
  const lines: string[] = [];
  if (link.title) lines.push(link.title);
  if (link.description && link.description !== link.title) {
    lines.push(link.description);
  }
  if (!lines.includes(link.href)) lines.push(link.href);
  return lines.join('\n');
}

export function parseGroupMessage(message: {
  threadId: string;
  isSelf: boolean;
  data: {
    content?: unknown;
    msgType?: string;
    msgId?: string | number;
    uidFrom?: string | number;
    dName?: string;
    ts?: string | number;
    propertyExt?: unknown;
    mentions?: unknown;
  };
}): NormalizedGroupMessage | null {
  const messageId =
    message.data.msgId != null ? String(message.data.msgId) : null;
  if (!messageId) return null;

  const content = message.data.content;
  const msgType = message.data.msgType;
  let text = '';
  const images: InboundImage[] = [];
  let keepRichStyles = false;

  let rtfStyles: ForwardStyle[] = [];

  if (typeof content === 'string') {
    text = content;
    keepRichStyles = true;
  } else if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    const isRtf =
      obj.action === 'rtf' ||
      (typeof obj.params === 'string' && obj.params.includes('"styles"'));

    if (isRtf && typeof obj.title === 'string') {
      // RTF: không trim — style offset theo đúng title (emoji surrogate)
      text = obj.title;
      rtfStyles = extractStylesFromParams(obj.params);
      keepRichStyles = true;
    } else {
      const imgs = extractInboundImages(content, msgType);
      if (imgs) {
        images.push(...imgs);
        text = captionFromPhotoContent(content);
      } else {
        const link = extractLinkAttachment(content, msgType);
        if (link) {
          text = formatLinkText(link);
          if (link.thumb) images.push({ url: link.thumb });
        } else {
          for (const key of ['title', 'description', 'text', 'msg', 'content']) {
            const v = obj[key];
            if (typeof v === 'string' && v.trim() && !v.startsWith('{')) {
              text = v.trim();
              break;
            }
          }
          if (!text.trim()) {
            text = `[tin ${msgType ?? 'không hỗ trợ'}]`;
          }
        }
      }
    }
  } else if (content == null) {
    text = `[tin ${msgType ?? 'trống'}]`;
  } else {
    return null;
  }

  if (!text.trim() && images.length === 0) return null;

  const stylesFromExt = keepRichStyles
    ? extractStylesFromPropertyExt(message.data.propertyExt)
    : [];
  const styles = rtfStyles.length > 0 ? rtfStyles : stylesFromExt;
  const mentions = keepRichStyles ? extractMentions(message.data.mentions) : [];

  const rawTs = message.data.ts != null ? Number(message.data.ts) : NaN;
  const ts = Number.isFinite(rawTs) ? rawTs : undefined;

  const propertyExt =
    message.data.propertyExt && typeof message.data.propertyExt === 'object'
      ? (message.data.propertyExt as { ext?: unknown })
      : null;
  const propertyExtExt =
    typeof propertyExt?.ext === 'string' ? propertyExt.ext : undefined;

  return {
    groupId: String(message.threadId),
    messageId,
    ts,
    senderId: message.data.uidFrom != null ? String(message.data.uidFrom) : undefined,
    senderName: typeof message.data.dName === 'string' ? message.data.dName : undefined,
    text,
    images,
    styles,
    mentions,
    propertyExtExt,
    isSelf: message.isSelf,
  };
}
