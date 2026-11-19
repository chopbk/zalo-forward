/** Tách nhiều zalo id: `111,222, 333` */
export function parseCommaIds(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;]+/)) {
    const id = part.trim();
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Lấy danh sách id ở đầu lệnh (có thể `id1,id2` hoặc nhiều token),
 * rồi phần còn lại (group|user / readonly / tên).
 */
export function takeLeadingIds(parts: string[]): { ids: string[]; rest: string[] } {
  if (parts.length === 0) return { ids: [], rest: [] };
  const idTokens: string[] = [];
  let i = 0;
  for (; i < parts.length; i++) {
    const p = parts[i]!;
    const lower = p.toLowerCase();
    if (lower === 'group' || lower === 'user') break;
    if (
      /^(readonly|ro|1way|oneway|inbound|inbound_only|inbound-only)$/i.test(p)
    ) {
      break;
    }
    if (p.includes('=')) break;
    if (/^[\d,\s;]+$/.test(p) || (p.includes(',') && !p.includes('='))) {
      idTokens.push(p);
      continue;
    }
    if (/^\d+$/.test(p)) {
      idTokens.push(p);
      continue;
    }
    break;
  }
  const ids = parseCommaIds(idTokens.join(','));
  return { ids, rest: parts.slice(i) };
}

export const INBOUND_ONLY_TOKENS = new Set([
  'readonly',
  'ro',
  '1way',
  'oneway',
  'inbound',
  'inbound_only',
  'inbound-only',
]);

/** Tách tin Telegram dài theo ~3900 ký tự. */
export async function replyChunks(
  reply: (text: string) => Promise<unknown>,
  text: string,
): Promise<void> {
  const MAX = 3900;
  if (text.length <= MAX) {
    await reply(text);
    return;
  }
  const lines = text.split('\n');
  let buf = '';
  for (const line of lines) {
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length > MAX && buf) {
      await reply(buf);
      buf = line;
    } else {
      buf = next;
    }
  }
  if (buf) await reply(buf);
}
