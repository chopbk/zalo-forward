import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ThreadType, type API, type ZaloListenerMessage } from 'zca-js';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import { getGroupActivityMap } from '../db/rules.js';
import { SendQueue } from '../relay/queue.js';
import {
  parseGroupMessage,
  type NormalizedGroupMessage,
} from '../relay/normalize.js';
import type { ForwardMention, ForwardStyle } from '../relay/styles.js';
import { downloadZaloMedia, safeUnlink, writeTempImage } from './media.js';

const GROUP_HISTORY_PROBE_LIMIT = 20;
const GROUP_HISTORY_PROBE_CONCURRENCY = 4;
/** Endpoint /api/group/history hay 404 trên nhiều tài khoản — bỏ probe sau vài lỗi liên tiếp. */
const GROUP_HISTORY_PROBE_FAIL_ABORT = 3;

function normalizeZaloTs(raw: number | undefined): number | undefined {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return undefined;
  return raw < 1e12 ? raw * 1000 : raw;
}

/** Pin id từ Zalo thường dạng `g123` / `u456`. */
function normalizePinId(raw: string): string {
  if (raw.startsWith('g') || raw.startsWith('u')) return raw.slice(1);
  return raw;
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const message = String((err as { message?: string }).message ?? '');
  return message.includes('404') || message.includes('Not Found');
}

async function probeGroupLastMessageTs(
  api: API,
  groupId: string,
): Promise<{ ts?: number; notFound?: boolean }> {
  if (typeof api.getGroupChatHistory !== 'function') return {};
  try {
    const hist = await api.getGroupChatHistory(groupId, 1);
    let best: number | undefined;
    for (const msg of hist.groupMsgs ?? []) {
      const raw = msg?.data?.ts ?? msg?.ts;
      const ts = normalizeZaloTs(raw != null ? Number(raw) : undefined);
      if (ts != null && (best == null || ts > best)) best = ts;
    }
    return { ts: best };
  } catch (err) {
    if (isNotFoundError(err)) return { notFound: true };
    logger.debug({ err, groupId }, 'getGroupChatHistory probe failed');
    return {};
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export type GroupInboundHandler = (
  msg: NormalizedGroupMessage,
) => void | Promise<void>;

export class PersonalAccountAdapter {
  private handler: GroupInboundHandler | null = null;
  private readonly queue: SendQueue;
  private started = false;
  /** Tin vừa gửi đi — bỏ echo isSelf để tránh vòng A→B→A. */
  private readonly recentOutbounds: Array<{ groupId: string; fingerprint: string; at: number }> =
    [];

  constructor(
    readonly tenantId: number,
    private readonly api: API,
    private readonly sessionPath: string,
  ) {
    const env = getEnv();
    this.queue = new SendQueue(env.ZALO_MIN_SEND_INTERVAL_MS, env.ZALO_SEND_MAX_PER_MINUTE);
  }

  private pruneOutbounds(now = Date.now()): void {
    const cutoff = now - 90_000;
    while (this.recentOutbounds.length > 0 && this.recentOutbounds[0]!.at < cutoff) {
      this.recentOutbounds.shift();
    }
    if (this.recentOutbounds.length > 80) {
      this.recentOutbounds.splice(0, this.recentOutbounds.length - 80);
    }
  }

  private fingerprintText(text: string): string {
    return text.trim().slice(0, 500);
  }

  private markOutbound(groupId: string, text: string): void {
    const fingerprint = this.fingerprintText(text);
    if (!fingerprint) return;
    this.pruneOutbounds();
    this.recentOutbounds.push({ groupId, fingerprint, at: Date.now() });
  }

  private isEchoOutbound(groupId: string, text: string): boolean {
    this.pruneOutbounds();
    const fingerprint = this.fingerprintText(text);
    if (!fingerprint) return false;
    return this.recentOutbounds.some(
      (o) => o.groupId === groupId && o.fingerprint === fingerprint,
    );
  }

  getOwnId(): string {
    return this.api.getOwnId();
  }

  onGroupMessage(handler: GroupInboundHandler): void {
    this.handler = handler;
  }

  start(): void {
    if (this.started) return;
    this.api.listener.on('message', (message) => {
      void this.handleMessage(message).catch((err) => {
        logger.error({ err, tenantId: this.tenantId }, 'Personal inbound failed');
      });
    });
    this.api.listener.start();
    this.started = true;
    logger.info({ tenantId: this.tenantId }, 'Personal listener started');
  }

  stop(): void {
    if (!this.started) return;
    try {
      this.api.listener.stop();
    } catch {
      // ignore
    }
    this.handler = null;
    this.started = false;
  }

  private async handleMessage(message: ZaloListenerMessage): Promise<void> {
    // Chỉ group — 1:1 với nick không forward
    if (message.type !== ThreadType.Group && Number(message.type) !== ThreadType.Group) {
      return;
    }
    if (!this.handler) return;

    // Dump raw để bắt format/style (propertyExt thường thiếu styles trên listener)
    void dumpInboundRaw(this.tenantId, message).catch((err) => {
      logger.debug({ err }, 'dumpInboundRaw failed');
    });

    const normalized = parseGroupMessage(message);
    if (!normalized) {
      logger.debug(
        {
          tenantId: this.tenantId,
          groupId: message.threadId,
          msgType: message.data?.msgType,
          isSelf: message.isSelf,
        },
        'Skip group message (unsupported / empty)',
      );
      return;
    }

    // Bỏ echo của chính lệnh gửi đi (tránh loop khi có luật ngược)
    if (normalized.isSelf && this.isEchoOutbound(normalized.groupId, normalized.text)) {
      logger.debug(
        { tenantId: this.tenantId, groupId: normalized.groupId },
        'Skip outbound echo',
      );
      return;
    }

    await this.handler(normalized);
  }

  async listGroups(): Promise<
    Array<{ groupId: string; name: string; lastActiveAt?: number; pinned?: boolean }>
  > {
    const all = await this.api.getAllGroups();
    const ids = Object.keys(all.gridVerMap ?? {});
    if (ids.length === 0) return [];
    const info = await this.api.getGroupInfo(ids);
    const map = info.gridInfoMap ?? {};

    // Unread + probe là nguồn chính cho thứ tự. Cache chỉ là fallback khi thiếu.
    const cached = getGroupActivityMap(this.tenantId);
    const lastById = new Map<string, number>();
    try {
      if (typeof this.api.getUnreadMark === 'function') {
        const unread = await this.api.getUnreadMark();
        for (const c of unread.data?.convsGroup ?? []) {
          const id = String(c.id ?? c.fromUid ?? '');
          const ts = normalizeZaloTs(c.ts != null ? Number(c.ts) : undefined);
          if (!id || ts == null) continue;
          lastById.set(id, Math.max(lastById.get(id) ?? 0, ts));
        }
      }
    } catch (err) {
      logger.warn({ err, tenantId: this.tenantId }, 'getUnreadMark failed');
    }

    const pinned = new Set<string>();
    try {
      if (typeof this.api.getPinConversations === 'function') {
        const pins = await this.api.getPinConversations();
        for (const p of pins.conversations ?? []) {
          pinned.add(normalizePinId(String(p)));
        }
      }
    } catch (err) {
      logger.warn({ err, tenantId: this.tenantId }, 'getPinConversations failed');
    }

    const groups = ids.map((id) => ({
      groupId: id,
      name: map[id]?.name ?? id,
      lastActiveAt: lastById.get(id) ?? cached.get(id),
      pinned: pinned.has(id),
    }));

    // Chỉ probe group chưa có unread/cache. Endpoint history hay 404 → abort sớm.
    const missing = groups.filter((g) => !(g.lastActiveAt && g.lastActiveAt > 0));
    const toProbe = [
      ...missing.filter((g) => g.pinned),
      ...missing.filter((g) => !g.pinned),
    ].slice(0, GROUP_HISTORY_PROBE_LIMIT);

    if (toProbe.length > 0 && typeof this.api.getGroupChatHistory === 'function') {
      let consecutiveNotFound = 0;
      let probedOk = 0;
      let aborted = false;
      const byId = new Map(groups.map((g) => [g.groupId, g]));

      await mapPool(toProbe, GROUP_HISTORY_PROBE_CONCURRENCY, async (g) => {
        if (aborted) return;
        const result = await probeGroupLastMessageTs(this.api, g.groupId);
        if (result.notFound) {
          consecutiveNotFound += 1;
          if (consecutiveNotFound >= GROUP_HISTORY_PROBE_FAIL_ABORT) {
            aborted = true;
          }
          return;
        }
        consecutiveNotFound = 0;
        if (!result.ts) return;
        probedOk += 1;
        const row = byId.get(g.groupId);
        if (!row) return;
        row.lastActiveAt = result.ts;
        lastById.set(g.groupId, result.ts);
      });

      if (aborted) {
        logger.info(
          { tenantId: this.tenantId, probedOk, missing: missing.length },
          'Bỏ probe lịch sử group (API 404) — xếp theo unread/cache/inbound',
        );
      } else if (probedOk > 0) {
        logger.info(
          { tenantId: this.tenantId, probedOk, missing: missing.length },
          'Probed group history for recent order',
        );
      }
    }

    groups.sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      const at = a.lastActiveAt ?? 0;
      const bt = b.lastActiveAt ?? 0;
      if (bt !== at) return bt - at;
      return a.name.localeCompare(b.name, 'vi', { sensitivity: 'base' });
    });

    return groups;
  }

  sendText(
    groupId: string,
    text: string,
    opts?: { styles?: ForwardStyle[]; mentions?: ForwardMention[] },
  ): Promise<{ messageId: string }> {
    return this.queue.enqueue(async () => {
      this.markOutbound(groupId, text);
      const styles = opts?.styles?.length ? opts.styles : undefined;
      const mentions = opts?.mentions?.length ? opts.mentions : undefined;
      const payload =
        styles || mentions
          ? {
              msg: text,
              ...(styles ? { styles } : {}),
              ...(mentions ? { mentions } : {}),
            }
          : text;
      const result = await this.api.sendMessage(payload, groupId, ThreadType.Group);
      return {
        messageId: String(result.message?.msgId ?? 'ok'),
      };
    });
  }

  /**
   * Gần nút Share Zalo Web — api.forwardMessage.
   * Hiện zca-js chủ yếu forward text (+ reference); ảnh/video chưa đủ.
   */
  forwardNative(
    destGroupId: string,
    text: string,
    reference?: { id: string; ts: number },
  ): Promise<{ messageId: string }> {
    return this.queue.enqueue(async () => {
      if (typeof this.api.forwardMessage !== 'function') {
        throw new Error('forwardMessage API unavailable');
      }
      this.markOutbound(destGroupId, text);
      const result = await this.api.forwardMessage(
        {
          message: text,
          reference: reference
            ? {
                id: reference.id,
                ts: reference.ts,
                logSrcType: 1,
                fwLvl: 1,
              }
            : undefined,
        },
        [destGroupId],
        ThreadType.Group,
      );
      const fail = result.fail?.[0];
      if (fail) {
        throw new Error(`forwardMessage fail: ${fail.error_code ?? 'unknown'}`);
      }
      const ok = result.success?.[0];
      return { messageId: String(ok?.msgId ?? 'ok') };
    });
  }

  sendImages(
    groupId: string,
    images: Array<{ url: string }>,
    caption = '',
  ): Promise<{ messageId: string }> {
    return this.queue.enqueue(async () => {
      const paths: string[] = [];
      try {
        for (const img of images) {
          const buf = await downloadZaloMedia(img.url, this.sessionPath);
          const path = await writeTempImage(buf);
          paths.push(path);
        }
        this.markOutbound(groupId, caption || '[image]');
        const result = await this.api.sendMessage(
          {
            msg: caption,
            attachments: paths.length === 1 ? paths[0]! : paths,
          },
          groupId,
          ThreadType.Group,
        );
        return {
          messageId: String(
            result.message?.msgId ?? result.attachment?.[0]?.msgId ?? 'ok',
          ),
        };
      } finally {
        await Promise.all(paths.map((p) => safeUnlink(p)));
      }
    });
  }
}

async function dumpInboundRaw(
  tenantId: number,
  message: ZaloListenerMessage,
): Promise<void> {
  const dir = join(getEnv().SESSION_DIR, '..', 'debug');
  await mkdir(dir, { recursive: true });
  const data = message.data as Record<string, unknown>;
  const payload = {
    at: new Date().toISOString(),
    tenantId,
    type: message.type,
    threadId: message.threadId,
    isSelf: message.isSelf,
    dataKeys: data && typeof data === 'object' ? Object.keys(data) : [],
    msgType: data?.msgType,
    msgId: data?.msgId,
    contentType: typeof data?.content,
    content:
      typeof data?.content === 'string'
        ? (data.content as string).slice(0, 500)
        : data?.content,
    propertyExt: data?.propertyExt,
    paramsExt: data?.paramsExt,
    mentions: data?.mentions,
    // một số bản có thể nhét style ngoài propertyExt
    textProperties: data?.textProperties,
    styles: data?.styles,
    rawData: data,
  };
  await writeFile(
    join(dir, `last-inbound-t${tenantId}.json`),
    JSON.stringify(payload, null, 2),
    'utf8',
  );
}
