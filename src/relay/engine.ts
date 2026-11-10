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
import { canRelay, findTenantById, getSession, type Tenant } from '../db/tenants.js';
import type { NormalizedGroupMessage } from './normalize.js';
import { resolveDestinations } from './match.js';
import {
  clipStylesToText,
  type ForwardMention,
  type ForwardStyle,
} from './styles.js';
import { sessionManager } from '../personal/manager.js';

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
  const hasImages = msg.images.length > 0;
  // Có styles RTF → bắt buộc sendMessage+styles (forwardMessage của zca-js mất format)
  // Native forward chỉ khi text thuần không style
  const preferNativeForward =
    !hasImages && !!body.text.trim() && body.styles.length === 0;

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

  const items: ForwardJobPayload[] = [...destSet].map((destGroupId) => ({
    sourceGroupId: msg.groupId,
    destGroupId,
    text: body.text,
    images: hasImages ? msg.images : undefined,
    styles: body.styles.length > 0 ? body.styles : undefined,
    mentions: body.mentions,
    sourceMessageId: msg.messageId,
    sourceTs: msg.ts,
    preferNativeForward,
    senderName: msg.senderName,
  }));

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
    },
    'Enqueued forward jobs',
  );
}

/** Copy đúng nội dung gốc — không gắn tên người gửi. */
function formatForwardBody(msg: NormalizedGroupMessage): {
  text: string;
  styles: ForwardStyle[];
  mentions?: ForwardMention[];
} {
  const text = msg.text ?? '';
  const styles = clipStylesToText(msg.styles ?? [], text);
  const mentions = msg.mentions ?? [];

  return {
    text,
    styles,
    mentions: mentions.length > 0 ? mentions : undefined,
  };
}

async function processOneJob(): Promise<boolean> {
  const job = claimNextJob();
  if (!job) return false;

  const adapter = sessionManager.getAdapter(job.tenantId);
  if (!adapter) {
    markJobFailedOrRetry(job.id, 'Session not running');
    return true;
  }

  const tenant = findTenantById(job.tenantId);
  const session = getSession(job.tenantId);
  if (!tenant || !canRelay(tenant, session)) {
    markJobFailedOrRetry(job.id, 'Tenant not relayable');
    return true;
  }

  try {
    const { payload } = job;
    if (payload.images && payload.images.length > 0) {
      await adapter.sendImages(
        payload.destGroupId,
        payload.images,
        payload.text ?? '',
      );
    } else if (payload.text) {
      let sent = false;
      if (payload.preferNativeForward) {
        try {
          const tsRaw = payload.sourceTs ?? Date.now();
          const ts = tsRaw < 1e12 ? tsRaw * 1000 : tsRaw;
          await adapter.forwardNative(payload.destGroupId, payload.text, {
            id: payload.sourceMessageId,
            ts,
          });
          sent = true;
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
        await adapter.sendText(payload.destGroupId, payload.text, {
          styles: payload.styles,
          mentions: payload.mentions,
        });
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
