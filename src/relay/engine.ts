import logger from '../config/logger.js';
import { listEnabledRulesForSource, touchGroupActivity } from '../db/rules.js';
import { claimProcessedMessage } from '../db/processed.js';
import {
  claimNextJob,
  enqueueForwardJobs,
  markJobDone,
  markJobFailedOrRetry,
  type ForwardJobPayload,
} from '../db/jobs.js';
import {
  resolveSignalQuote,
  upsertSignalOrder,
} from '../db/signal-orders.js';
import {
  insertSignalEvent,
  updateSignalEventDestMessage,
} from '../db/signal-events.js';
import { canRelay, findTenantById, getSession, type Tenant } from '../db/tenants.js';
import type { NormalizedGroupMessage } from './normalize.js';
import { resolveDestinations } from './match.js';
import {
  clipStylesToText,
  type ForwardMention,
  type ForwardStyle,
} from './styles.js';
import { sessionManager } from '../personal/manager.js';
import { reformatSignalMessage } from './reformat-signal.js';
import { parseSignalMeta, type SignalMeta } from './signal-meta.js';
import { isTelegramDest, parseTelegramDest } from '../telegram/dest.js';
import { sendPayloadToTelegramTopic } from '../telegram/send.js';
import { findTopicById } from '../db/telegram-topics.js';

let drainTimer: ReturnType<typeof setInterval> | null = null;
let draining = false;

export async function handleGroupInbound(
  tenant: Tenant,
  msg: NormalizedGroupMessage,
): Promise<void> {
  const fresh = findTenantById(tenant.id);
  const session = getSession(tenant.id);
  if (!fresh || !canRelay(fresh, session)) {
    return;
  }

  if (!claimProcessedMessage(tenant.id, msg.messageId)) {
    return;
  }

  touchGroupActivity(tenant.id, msg.groupId, Date.now(), undefined);

  const rules = listEnabledRulesForSource(tenant.id, msg.groupId);
  if (rules.length === 0) {
    logger.debug(
      {
        tenantId: tenant.id,
        groupId: msg.groupId,
        sender: msg.senderName ?? msg.senderId,
      },
      'Group inbound — no enabled rule for this source',
    );
    return;
  }

  const matched = resolveDestinations(rules, msg.groupId, msg.text);
  if (matched.length === 0) {
    logger.debug(
      { tenantId: tenant.id, groupId: msg.groupId, filter: 'no match' },
      'Group inbound — rules present but filter skipped',
    );
    return;
  }

  const destSet = new Set<string>();
  for (const m of matched) {
    for (const d of m.destGroupIds) destSet.add(d);
  }

  const body = formatForwardBody(msg);
  const signal = parseSignalMeta(msg.text ?? '') ?? parseSignalMeta(body.text);
  const hasImages = msg.images.length > 0;
  // Có styles RTF → bắt buộc sendMessage+styles (forwardMessage của zca-js mất format)
  // Native forward chỉ khi text thuần không style; tin đã reformat / cần quote phải sendText
  const needsSignalReply = !!signal;
  const preferNativeForward =
    !body.reformatted &&
    !needsSignalReply &&
    !hasImages &&
    !!body.text.trim() &&
    body.styles.length === 0;

  if (body.styles.length > 0) {
    logger.info(
      {
        tenantId: tenant.id,
        messageId: msg.messageId,
        styles: body.styles.length,
      },
      'Inbound RTF/styles — sẽ gửi lại bằng sendMessage+styles',
    );
  }

  const items: ForwardJobPayload[] = [...destSet].map((destGroupId) => {
    const signalStore = buildSignalStore(signal);
    const signalQuote =
      signal && signal.quotePrefer.length > 0
        ? {
            prefer: signal.quotePrefer,
            pendingKey: signal.pendingKey,
            filledKey: signal.filledKey,
          }
        : undefined;

    const topicId = parseTelegramDest(destGroupId);
    const isTg = topicId != null;
    const topic = isTg ? findTopicById(topicId) : null;

    return {
      sourceGroupId: msg.groupId,
      destGroupId,
      destType: isTg ? ('telegram' as const) : ('zalo' as const),
      telegramTopicId: topicId ?? undefined,
      telegramChatId: topic?.telegramChatId,
      text: body.text,
      rawText: msg.text ?? '',
      reformatted: body.reformatted,
      images: hasImages ? msg.images : undefined,
      styles: body.styles.length > 0 ? body.styles : undefined,
      mentions: body.mentions,
      sourceMessageId: msg.messageId,
      sourceTs: msg.ts,
      preferNativeForward: isTg ? false : preferNativeForward,
      senderName: msg.senderName,
      signalQuote: isTg ? undefined : signalQuote,
      signalStore: isTg ? undefined : signalStore,
      signalMeta: signal,
    };
  });

  // Lưu sớm để backtest kể cả khi job gửi lỗi / retry
  for (const item of items) {
    try {
      insertSignalEvent({
        tenantId: tenant.id,
        sourceGroupId: item.sourceGroupId,
        sourceMessageId: item.sourceMessageId,
        sourceTs: item.sourceTs,
        destGroupId: item.destGroupId,
        senderName: item.senderName,
        rawText: item.rawText ?? item.text ?? '',
        forwardedText: item.text ?? '',
        reformatted: !!item.reformatted,
        signal: item.signalMeta ?? null,
      });
    } catch (err) {
      logger.warn({ err, messageId: item.sourceMessageId }, 'insertSignalEvent failed');
    }
  }

  enqueueForwardJobs(tenant.id, items);
  logger.info(
    {
      tenantId: tenant.id,
      source: msg.groupId,
      dests: items.length,
      messageId: msg.messageId,
      sender: msg.senderName ?? msg.senderId,
      isSelf: msg.isSelf,
      styles: body.styles?.length ?? 0,
      preferNativeForward,
      reformatted: body.reformatted,
      signalKind: signal?.kind,
      willQuote: !!signal && signal.quotePrefer.length > 0,
    },
    'Enqueued forward jobs',
  );
}

function buildSignalStore(
  signal: SignalMeta | null,
): ForwardJobPayload['signalStore'] {
  if (!signal?.storeAs) return undefined;
  if (signal.storeAs === 'pending') {
    return {
      kind: 'pending',
      orderKey: signal.pendingKey,
      signalKind: signal.kind,
    };
  }
  if (signal.storeAs === 'filled' && signal.filledKey) {
    return {
      kind: 'filled',
      orderKey: signal.filledKey,
      signalKind: signal.kind,
    };
  }
  return undefined;
}

/** Copy nội dung gốc; nếu khớp mẫu tín hiệu cũ → đổi sang format mới. */
function formatForwardBody(msg: NormalizedGroupMessage): {
  text: string;
  styles: ForwardStyle[];
  mentions?: ForwardMention[];
  reformatted: boolean;
} {
  const original = msg.text ?? '';
  const reformatted = reformatSignalMessage(original);
  if (reformatted) {
    return {
      text: reformatted,
      styles: [],
      mentions: undefined,
      reformatted: true,
    };
  }
  const styles = clipStylesToText(msg.styles ?? [], original);
  const mentions = msg.mentions ?? [];
  return {
    text: original,
    styles,
    mentions: mentions.length > 0 ? mentions : undefined,
    reformatted: false,
  };
}

async function processOneJob(): Promise<boolean> {
  const job = claimNextJob();
  if (!job) return false;

  const tenant = findTenantById(job.tenantId);
  const session = getSession(job.tenantId);
  if (!tenant || !canRelay(tenant, session)) {
    markJobFailedOrRetry(job.id, 'Tenant not relayable');
    return true;
  }

  try {
    const { payload } = job;
    const destType =
      payload.destType ??
      (isTelegramDest(payload.destGroupId) ? 'telegram' : 'zalo');

    if (destType === 'telegram') {
      const topicId =
        payload.telegramTopicId ?? parseTelegramDest(payload.destGroupId);
      if (!topicId) {
        throw new Error(`Invalid telegram dest: ${payload.destGroupId}`);
      }
      await sendPayloadToTelegramTopic({
        topicId,
        chatId: payload.telegramChatId,
        text: payload.text,
        styles: payload.styles,
        images: payload.images,
        senderName: payload.senderName,
      });
      markJobDone(job.id);
      return true;
    }

    const adapter = sessionManager.getAdapter(job.tenantId);
    if (!adapter) {
      markJobFailedOrRetry(job.id, 'Session not running');
      return true;
    }

    if (payload.images && payload.images.length > 0) {
      await adapter.sendImages(
        payload.destGroupId,
        payload.images,
        payload.text ?? '',
      );
    } else if (payload.text) {
      let sent = false;
      let sentMeta: { messageId: string; cliMsgId: string; ts: string } | null =
        null;

      const quote = payload.signalQuote
        ? resolveSignalQuote(
            job.tenantId,
            payload.destGroupId,
            payload.signalQuote.prefer,
            {
              pendingKey: payload.signalQuote.pendingKey,
              filledKey: payload.signalQuote.filledKey,
            },
          )
        : null;

      // Có quote → luôn sendMessage (native forward không reply được)
      if (payload.preferNativeForward && !quote) {
        try {
          const tsRaw = payload.sourceTs ?? Date.now();
          const ts = tsRaw < 1e12 ? tsRaw * 1000 : tsRaw;
          const r = await adapter.forwardNative(payload.destGroupId, payload.text, {
            id: payload.sourceMessageId,
            ts,
          });
          sent = true;
          sentMeta = {
            messageId: r.messageId,
            cliMsgId: '',
            ts: String(Date.now()),
          };
          logger.info(
            { jobId: job.id, dest: payload.destGroupId },
            'Forwarded via native forwardMessage',
          );
        } catch (err) {
          logger.warn(
            { err, jobId: job.id },
            'native forwardMessage failed — fallback sendMessage',
          );
        }
      }
      if (!sent) {
        try {
          const r = await adapter.sendText(payload.destGroupId, payload.text, {
            styles: payload.styles,
            mentions: payload.mentions,
            quote: quote ?? undefined,
          });
          sentMeta = r;
          logger.info(
            {
              jobId: job.id,
              dest: payload.destGroupId,
              quoted: !!quote,
              quoteMsgId: quote?.msgId,
            },
            'Forwarded via sendMessage',
          );
        } catch (err) {
          if (!quote) throw err;
          logger.warn(
            { err, jobId: job.id },
            'sendMessage with quote failed — retry without quote',
          );
          const r = await adapter.sendText(payload.destGroupId, payload.text, {
            styles: payload.styles,
            mentions: payload.mentions,
          });
          sentMeta = r;
        }
      }

      if (sentMeta && sentMeta.messageId !== 'ok') {
        try {
          updateSignalEventDestMessage(
            job.tenantId,
            payload.sourceMessageId,
            payload.destGroupId,
            sentMeta.messageId,
          );
        } catch (err) {
          logger.warn({ err, jobId: job.id }, 'updateSignalEventDestMessage failed');
        }

        if (payload.signalStore) {
          upsertSignalOrder({
            tenantId: job.tenantId,
            destGroupId: payload.destGroupId,
            orderKey: payload.signalStore.orderKey,
            kind: payload.signalStore.kind,
            msgId: sentMeta.messageId,
            cliMsgId: sentMeta.cliMsgId,
            uidFrom: adapter.getOwnId(),
            content: (payload.text ?? '').split('\n')[0]?.slice(0, 200) ?? '',
            ts: sentMeta.ts,
          });
          logger.info(
            {
              jobId: job.id,
              orderKey: payload.signalStore.orderKey,
              kind: payload.signalStore.kind,
              msgId: sentMeta.messageId,
            },
            'Stored signal order anchor for replies',
          );
        }
      }
    }
    markJobDone(job.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, jobId: job.id }, 'Forward job failed');
    markJobFailedOrRetry(job.id, message);
  }
  return true;
}

export async function drainJobs(max = 20): Promise<number> {
  if (draining) return 0;
  draining = true;
  let n = 0;
  try {
    while (n < max) {
      const did = await processOneJob();
      if (!did) break;
      n += 1;
    }
  } finally {
    draining = false;
  }
  return n;
}

export function startJobWorker(intervalMs = 500): void {
  if (drainTimer) return;
  drainTimer = setInterval(() => {
    void drainJobs().catch((err) => logger.error({ err }, 'drainJobs error'));
  }, intervalMs);
  // unref so tests/process can exit
  if (typeof drainTimer === 'object' && 'unref' in drainTimer) {
    drainTimer.unref();
  }
}

export function stopJobWorker(): void {
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
}
