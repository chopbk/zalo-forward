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
  senderId?: string;
  senderName?: string;
  text: string;
  images: InboundImage[];
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
  };
}): NormalizedGroupMessage | null {
  const messageId =
    message.data.msgId != null ? String(message.data.msgId) : null;
  if (!messageId) return null;

  const content = message.data.content;
  const msgType = message.data.msgType;
  let text = '';
  const images: InboundImage[] = [];

  if (typeof content === 'string') {
    text = content;
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
        return null;
      }
    }
  }

  if (!text.trim() && images.length === 0) return null;

  return {
    groupId: String(message.threadId),
    messageId,
    senderId: message.data.uidFrom != null ? String(message.data.uidFrom) : undefined,
    senderName: typeof message.data.dName === 'string' ? message.data.dName : undefined,
    text,
    images,
    isSelf: message.isSelf,
  };
}
