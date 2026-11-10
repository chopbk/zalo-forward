/** Style range tương thích zca-js TextStyle / sendMessage styles. */
export type ForwardStyle = {
  start: number;
  len: number;
  st: string;
  indentSize?: number;
};

export type ForwardMention = {
  pos: number;
  uid: string;
  len: number;
};

/**
 * Styles tin đến có thể nằm ở:
 * - propertyExt.ext
 * - content.params (tin RTF: action=rtf)
 * dạng { styles:[{ start, len, st:"b" | "b,c_db342e" }], ver:0 }
 */
export function extractStylesFromPropertyExt(propertyExt: unknown): ForwardStyle[] {
  if (!propertyExt || typeof propertyExt !== 'object') return [];
  const ext = (propertyExt as { ext?: unknown }).ext;
  return extractStylesFromParams(ext);
}

/** Parse styles từ content.params (RTF) hoặc propertyExt.ext. */
export function extractStylesFromParams(params: unknown): ForwardStyle[] {
  const parsed = parseJsonMaybe(params);
  if (!parsed || typeof parsed !== 'object') return [];
  const styles = (parsed as { styles?: unknown }).styles;
  // styles đôi khi là JSON string lồng
  if (typeof styles === 'string') {
    return normalizeStyleList(parseJsonMaybe(styles));
  }
  return normalizeStyleList(styles);
}

export function extractMentions(raw: unknown): ForwardMention[] {
  if (!Array.isArray(raw)) return [];
  const out: ForwardMention[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const pos = Number(m.pos);
    const len = Number(m.len);
    const uid = m.uid != null ? String(m.uid) : '';
    if (!uid || !Number.isFinite(pos) || !Number.isFinite(len) || pos < 0 || len <= 0) {
      continue;
    }
    out.push({ pos, uid, len });
  }
  return out;
}

export function offsetStyles(styles: ForwardStyle[], offset: number): ForwardStyle[] {
  if (offset === 0) return styles.map((s) => ({ ...s }));
  return styles.map((s) => ({ ...s, start: s.start + offset }));
}

export function offsetMentions(
  mentions: ForwardMention[],
  offset: number,
): ForwardMention[] {
  if (offset === 0) return mentions.map((m) => ({ ...m }));
  return mentions.map((m) => ({ ...m, pos: m.pos + offset }));
}

/** Zalo style offset theo string.length (UTF-16), giống JS. */
export function clipStylesToText(styles: ForwardStyle[], text: string): ForwardStyle[] {
  const limit = text.length;
  return styles.filter(
    (s) =>
      Number.isFinite(s.start) &&
      Number.isFinite(s.len) &&
      s.start >= 0 &&
      s.len > 0 &&
      s.start < limit &&
      s.start + s.len <= limit &&
      typeof s.st === 'string' &&
      s.st.length > 0,
  );
}

function parseJsonMaybe(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function normalizeStyleList(styles: unknown): ForwardStyle[] {
  if (!Array.isArray(styles)) return [];
  const out: ForwardStyle[] = [];
  for (const raw of styles) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const start = Number(s.start);
    const len = Number(s.len);
    const stRaw = typeof s.st === 'string' ? s.st : '';
    if (!Number.isFinite(start) || !Number.isFinite(len) || start < 0 || len <= 0 || !stRaw) {
      continue;
    }

    // RTF Zalo: "b,c_db342e" = vừa đậm vừa đỏ → tách thành nhiều style
    const parts = stRaw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    for (const stPart of parts.length > 0 ? parts : [stRaw]) {
      let st = stPart;
      let indentSize: number | undefined;
      const indentMatch = /^ind_(\d+)$/.exec(st);
      if (indentMatch) {
        const n = Number(indentMatch[1]);
        indentSize = Number.isFinite(n) ? Math.max(1, Math.floor(n / 10) || 1) : 1;
        st = 'ind_$';
      } else if (st === 'ind_$') {
        const n = Number(s.indentSize);
        indentSize = Number.isFinite(n) && n > 0 ? n : 1;
      }

      const item: ForwardStyle = { start, len, st };
      if (indentSize != null) item.indentSize = indentSize;
      out.push(item);
    }
  }
  return out;
}
