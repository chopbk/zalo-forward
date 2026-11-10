export type ParsedAddRule = {
  sourceGroupId: string;
  targets: string[];
  filterMode: 'all' | 'keywords';
  keywords: string[];
};

export const ADDRULE_USAGE =
  `Format:\n` +
  `/addrule <id_nguồn> <id_đích,...> all\n` +
  `/addrule <id_nguồn> <id_đích,...> keywords <từ_khóa,...>\n\n` +
  `Ví dụ:\n` +
  `/addrule 9045111 9045222,9045333 all\n` +
  `/addrule 9045111 9045222,9045333 keywords sale,hot,giảm giá\n\n` +
  `Lấy id: /groups`;

/**
 * Parse: /addrule <source> <dest,dest,...> [all|keywords <kw,...>]
 */
export function parseAddRuleCommand(text: string): ParsedAddRule | { error: string } {
  const raw = text.trim().replace(/^\/addrule\s*/i, '').trim();
  if (!raw) return { error: ADDRULE_USAGE };

  // Tách: source, destList, optional filter + rest
  const m = raw.match(
    /^(\S+)\s+(\S+)(?:\s+(all|keywords)(?:\s+(.+))?)?\s*$/i,
  );
  if (!m) return { error: `Sai format.\n\n${ADDRULE_USAGE}` };

  const sourceGroupId = m[1]!;
  const targets = m[2]!
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const filterRaw = (m[3] ?? 'all').toLowerCase();
  const kwRaw = (m[4] ?? '').trim();

  if (targets.length === 0) {
    return { error: `Thiếu group đích.\n\n${ADDRULE_USAGE}` };
  }

  if (filterRaw === 'all') {
    return {
      sourceGroupId,
      targets,
      filterMode: 'all',
      keywords: [],
    };
  }

  if (filterRaw === 'keywords') {
    const keywords = kwRaw
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (keywords.length === 0) {
      return {
        error:
          `Chế độ keywords cần ít nhất 1 từ khóa.\n` +
          `Ví dụ: /addrule ${sourceGroupId} ${targets.join(',')} keywords sale,hot\n\n` +
          ADDRULE_USAGE,
      };
    }
    return {
      sourceGroupId,
      targets,
      filterMode: 'keywords',
      keywords,
    };
  }

  return { error: `Sai format.\n\n${ADDRULE_USAGE}` };
}
