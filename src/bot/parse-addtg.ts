export type ParsedAddTg = {
  sourceGroupId: string;
  filterMode: 'all' | 'keywords';
  keywords: string[];
  /** true = chỉ Zalo→TG, không reply topic→Zalo */
  inboundOnly: boolean;
};

export const ADDTG_USAGE =
  `Format:\n` +
  `/addtg <id_nguồn> [all|keywords <từ_khóa,...>] [twoway]\n\n` +
  `Mặc định readonly (chỉ Zalo→TG). Thêm twoway nếu muốn reply topic→Zalo.\n` +
  `Có thể kết hợp Zalo dest: /addrule <nguồn> tg,9045… all\n\n` +
  `Ví dụ:\n` +
  `/addtg 9045111 all\n` +
  `/addtg 9045111 keywords sale,hot\n` +
  `/addtg 9045111 all twoway`;

/**
 * Parse: /addtg <source> [all|keywords <kw,...>] [readonly|twoway]
 * Mặc định inboundOnly=true (readonly).
 */
export function parseAddTgCommand(text: string): ParsedAddTg | { error: string } {
  let raw = text.trim().replace(/^\/addtg\s*/i, '').trim();
  if (!raw) return { error: ADDTG_USAGE };

  let inboundOnly = true;
  if (/\b(twoway|readwrite|rw|2way)\b/i.test(raw)) {
    inboundOnly = false;
    raw = raw.replace(/\b(twoway|readwrite|rw|2way)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  }
  if (/\b(readonly|oneway|inbound_only|1way|ro)\b/i.test(raw)) {
    inboundOnly = true;
    raw = raw
      .replace(/\b(readonly|oneway|inbound_only|1way|ro)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const m = raw.match(/^(\S+)(?:\s+(all|keywords)(?:\s+(.+))?)?\s*$/i);
  if (!m) return { error: `Sai format.\n\n${ADDTG_USAGE}` };

  const sourceGroupId = m[1]!;
  const mode = (m[2] ?? 'all').toLowerCase();
  if (mode === 'all') {
    return { sourceGroupId, filterMode: 'all', keywords: [], inboundOnly };
  }
  if (mode === 'keywords') {
    const keywords = (m[3] ?? '')
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (keywords.length === 0) {
      return {
        error:
          `Chế độ keywords cần ít nhất 1 từ khóa.\n` +
          `Ví dụ: /addtg ${sourceGroupId} keywords sale,hot\n\n` +
          ADDTG_USAGE,
      };
    }
    return { sourceGroupId, filterMode: 'keywords', keywords, inboundOnly };
  }
  return { error: `Sai format.\n\n${ADDTG_USAGE}` };
}
