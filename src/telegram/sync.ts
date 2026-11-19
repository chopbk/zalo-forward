import logger from '../config/logger.js';
import {
  deleteMessageLink,
  findMessageLinkByTelegram,
  findMessageLinkByZalo,
  updateMessageLinkZaloIds,
  type MessageLink,
} from '../db/message-links.js';
import type { PersonalAccountAdapter } from '../personal/adapter.js';
import {
  telegramEntitiesToZaloStyles,
  type TelegramEntityLike,
} from './format.js';

const suppressedZaloUndos = new Map<string, number>();
const SUPPRESS_TTL_MS = 60_000;

function suppressKey(tenantId: number, zaloMsgId: string): string {
  return `${tenantId}:${zaloMsgId}`;
}

export function suppressZaloUndoEcho(tenantId: number, zaloMsgId: string): void {
  suppressedZaloUndos.set(suppressKey(tenantId, zaloMsgId), Date.now() + SUPPRESS_TTL_MS);
}

function isZaloUndoSuppressed(tenantId: number, zaloMsgId: string): boolean {
  const key = suppressKey(tenantId, zaloMsgId);
  const until = suppressedZaloUndos.get(key);
  if (until == null) return false;
  if (Date.now() > until) {
    suppressedZaloUndos.delete(key);
    return false;
  }
  return true;
}

export type NormalizedUndo = {
  targetMsgId?: string;
  zaloThreadId?: string;
};

/** Zalo thu hồi → giữ tin TG làm log, chỉ gỡ map. */
export function wireZaloUndoSync(adapter: PersonalAccountAdapter): void {
  adapter.onUndo(async (undo) => {
    try {
      await handleZaloUndo(adapter.tenantId, undo);
    } catch (err) {
      logger.error({ err, undo }, 'Zalo undo handler failed');
    }
  });
}

async function handleZaloUndo(
  tenantId: number,
  undo: NormalizedUndo,
): Promise<void> {
  const zaloMsgId = undo.targetMsgId;
  if (!zaloMsgId) return;

  if (isZaloUndoSuppressed(tenantId, zaloMsgId)) {
    logger.info({ zaloMsgId, tenantId }, 'Skip Zalo undo echo (bridge-initiated)');
    return;
  }

  const link = findMessageLinkByZalo(tenantId, zaloMsgId);
  if (!link) {
    logger.info(
      { zaloMsgId, threadId: undo.zaloThreadId },
      'Zalo undo without message link — skip',
    );
    return;
  }

  deleteMessageLink(link.id);
  logger.info(
    {
      zaloMsgId,
      telegramMessageId: link.telegramMessageId,
      topicId: link.telegramTopicId,
    },
    'Zalo undo noted — Telegram message kept as log',
  );
}

export async function syncTelegramDeleteToZalo(
  adapter: PersonalAccountAdapter,
  chatId: string,
  messageId: number,
): Promise<{ ok: true; link: MessageLink } | { ok: false; reason: string }> {
  const link = findMessageLinkByTelegram(adapter.tenantId, chatId, messageId);
  if (!link) {
    return {
      ok: false,
      reason: 'Không tìm thấy tin Zalo tương ứng (chỉ xoá được tin đã bridge)',
    };
  }

  if (!link.zaloCliMsgId) {
    return {
      ok: false,
      reason:
        'Chưa kịp lưu cliMsgId Zalo — đợi vài giây rồi /del lại, hoặc tin quá cũ',
    };
  }

  suppressZaloUndoEcho(adapter.tenantId, link.zaloMsgId);
  try {
    await adapter.undoMessage({
      msgId: link.zaloMsgId,
      cliMsgId: link.zaloCliMsgId,
      threadId: link.zaloThreadId,
      threadKind: link.threadKind,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Thu hồi Zalo thất bại: ${detail}` };
  }

  deleteMessageLink(link.id);
  logger.info(
    {
      zaloMsgId: link.zaloMsgId,
      telegramMessageId: messageId,
      direction: link.direction,
    },
    'Synced Telegram delete → Zalo undo',
  );
  return { ok: true, link };
}

export async function syncTelegramEditToZalo(
  adapter: PersonalAccountAdapter,
  chatId: string,
  messageId: number,
  newText: string,
  entities?: TelegramEntityLike[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const link = findMessageLinkByTelegram(adapter.tenantId, chatId, messageId);
  if (!link) return { ok: false, reason: 'no-link' };
  if (link.direction !== 't2z') return { ok: false, reason: 'not-outbound' };
  if (link.bodyText != null && link.bodyText === newText) return { ok: true };

  if (link.zaloCliMsgId) {
    suppressZaloUndoEcho(adapter.tenantId, link.zaloMsgId);
    try {
      await adapter.undoMessage({
        msgId: link.zaloMsgId,
        cliMsgId: link.zaloCliMsgId,
        threadId: link.zaloThreadId,
        threadKind: link.threadKind,
      });
    } catch (err) {
      logger.warn(
        { err, zaloMsgId: link.zaloMsgId },
        'Undo before edit failed — vẫn gửi tin mới',
      );
    }
  }

  const styles = telegramEntitiesToZaloStyles(newText, entities);
  try {
    const result = await adapter.sendText(link.zaloThreadId, newText, {
      threadKind: link.threadKind,
      styles: styles.length ? styles : undefined,
    });
    updateMessageLinkZaloIds(
      adapter.tenantId,
      chatId,
      messageId,
      result.messageId,
      result.cliMsgId ?? null,
      newText,
    );
    logger.info(
      {
        oldZaloMsgId: link.zaloMsgId,
        newZaloMsgId: result.messageId,
        telegramMessageId: messageId,
      },
      'Synced Telegram edit → Zalo undo+resend',
    );
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: detail };
  }
}
