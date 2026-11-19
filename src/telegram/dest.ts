/** Dest key trong rule_targets cho Telegram topic. */
export const TG_DEST_PREFIX = 'tg:#';

export function isTelegramDest(dest: string): boolean {
  return dest.startsWith(TG_DEST_PREFIX);
}

export function telegramDestKey(topicId: number): string {
  return `${TG_DEST_PREFIX}${topicId}`;
}

export function parseTelegramDest(dest: string): number | null {
  if (!isTelegramDest(dest)) return null;
  const n = Number(dest.slice(TG_DEST_PREFIX.length));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Token user gõ trong /addrule: `tg` hoặc `telegram`. */
export function isTelegramTargetToken(token: string): boolean {
  const t = token.trim().toLowerCase();
  return t === 'tg' || t === 'telegram';
}
