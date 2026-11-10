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
  `Cùng nguồn → tự sửa luật cũ (không tạo trùng).\n` +
  `Hoặc: /rules set <id_luật> <id_đích,...> all\n\n` +
  `Ví dụ:\n` +
  `/addrule 9045111 9045222 all\n` +
  `/addrule 9045111 9045222,9045333 all\n\n` +
  `Lấy id: /groups · xem luật: /rules`;

export const RULES_SET_USAGE =
  `Format:\n` +
  `/rules set <id_luật> <id_đích,...> all\n` +
  `/rules set <id_luật> <id_đích,...> keywords <từ_khóa,...>\n\n` +
  `Ví dụ: /rules set 3 9045222,9045333 all`;

function parseTargetsAndFilter(
  targetsRaw: string,
  filterRaw: string | undefined,
  kwRaw: string,
  usage: string,
  examplePrefix: string,
):
  | { targets: string[]; filterMode: 'all' | 'keywords'; keywords: string[] }
  | { error: string } {
  const targets = targetsRaw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (targets.length === 0) {
    return { error: `Thiếu group đích.\n\n${usage}` };
  }

  const mode = (filterRaw ?? 'all').toLowerCase();
  if (mode === 'all') {
    return { targets, filterMode: 'all', keywords: [] };
  }
  if (mode === 'keywords') {
    const keywords = kwRaw
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (keywords.length === 0) {
      return {
        error:
          `Chế độ keywords cần ít nhất 1 từ khóa.\n` +
          `Ví dụ: ${examplePrefix} keywords sale,hot\n\n` +
          usage,
      };
    }
    return { targets, filterMode: 'keywords', keywords };
  }
  return { error: `Sai format.\n\n${usage}` };
}

/**
 * Parse: /addrule <source> <dest,dest,...> [all|keywords <kw,...>]
 */
export function parseAddRuleCommand(text: string): ParsedAddRule | { error: string } {
  const raw = text.trim().replace(/^\/addrule\s*/i, '').trim();
  if (!raw) return { error: ADDRULE_USAGE };

  const m = raw.match(
    /^(\S+)\s+(\S+)(?:\s+(all|keywords)(?:\s+(.+))?)?\s*$/i,
  );
  if (!m) return { error: `Sai format.\n\n${ADDRULE_USAGE}` };

  const sourceGroupId = m[1]!;
  const parsed = parseTargetsAndFilter(
    m[2]!,
    m[3],
    (m[4] ?? '').trim(),
    ADDRULE_USAGE,
    `/addrule ${sourceGroupId} ${m[2]!}`,
  );
  if ('error' in parsed) return parsed;
  return { sourceGroupId, ...parsed };
}

export type ParsedSetRule = {
  ruleId: number;
  targets: string[];
  filterMode: 'all' | 'keywords';
  keywords: string[];
};

/**
 * Parse phần sau /rules set: <id> <dest,...> [all|keywords <kw,...>]
 */
export function parseSetRuleArgs(rest: string): ParsedSetRule | { error: string } {
  const raw = rest.trim();
  if (!raw) return { error: RULES_SET_USAGE };

  const m = raw.match(
    /^(\d+)\s+(\S+)(?:\s+(all|keywords)(?:\s+(.+))?)?\s*$/i,
  );
  if (!m) return { error: `Sai format.\n\n${RULES_SET_USAGE}` };

  const ruleId = Number(m[1]);
  if (!Number.isFinite(ruleId)) return { error: RULES_SET_USAGE };

  const parsed = parseTargetsAndFilter(
    m[2]!,
    m[3],
    (m[4] ?? '').trim(),
    RULES_SET_USAGE,
    `/rules set ${ruleId} ${m[2]!}`,
  );
  if ('error' in parsed) return parsed;
  return { ruleId, ...parsed };
}
