import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ThreadType, type API, type ZaloListenerMessage } from 'zca-js';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import { getGroupActivityMap, listGroupCache } from '../db/rules.js';
import { SendQueue } from '../relay/queue.js';
import {
  parseGroupMessage,
  type NormalizedGroupMessage,
} from '../relay/normalize.js';
import type { ForwardMention, ForwardStyle } from '../relay/styles.js';
import { downloadZaloMedia, safeUnlink, writeTempImage } from './media.js';

const GROUP_HISTORY_PROBE_LIMIT = 120;
const GROUP_HISTORY_PROBE_CONCURRENCY = 6;
/** Fallback /api/group/history hay 404 — abort sớm nếu không có getCloudMessage. */
const GROUP_HISTORY_PROBE_FAIL_ABORT = 3;

type ApiWithCloud = API & {
  getCloudMessage?: (
    groupId: string,
    lastMsgId?: string,
    options?: { isOld?: boolean | number },
  ) => Promise<{
    groupMsgs?: Array<{
      data?: { ts?: string | number; msgId?: string | number };
      ts?: string | number;
      type?: number;
      threadId?: string;
      isSelf?: boolean;
    }>;
    lastMsgId?: string;
    hasMore?: number;
    isOld?: number;
    isFiltered?: number | boolean;
  }>;
  undo?: (
    payload: { msgId: string | number; cliMsgId: string | number },
    threadId: string,
    type?: ThreadType,
  ) => Promise<unknown>;
};

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

function bestMsgTs(
  msgs: Array<{ data?: { ts?: string | number }; ts?: string | number }> | undefined,
): number | undefined {
  let best: number | undefined;
  for (const msg of msgs ?? []) {
    const raw = msg?.data?.ts ?? msg?.ts;
    const ts = normalizeZaloTs(raw != null ? Number(raw) : undefined);
    if (ts != null && (best == null || ts > best)) best = ts;
  }
  return best;
}

async function probeGroupLastMessageTs(
  api: API,
  groupId: string,
): Promise<{ ts?: number; notFound?: boolean }> {
  const cloudApi = api as ApiWithCloud;
  if (typeof cloudApi.getCloudMessage === 'function') {
    try {
      try {
        if (typeof api.getGroupInfo === 'function') await api.getGroupInfo(groupId);
      } catch {
        // warm context — ignore
      }
      const page = await cloudApi.getCloudMessage(groupId);
      return { ts: bestMsgTs(page.groupMsgs) };
    } catch (err) {
      logger.debug({ err, groupId }, 'getCloudMessage probe failed');
    }
  }

  if (typeof api.getGroupChatHistory !== 'function') return {};
  try {
    const hist = await api.getGroupChatHistory(groupId, 1);
    return { ts: bestMsgTs(hist.groupMsgs) };
  } catch (err) {
    if (isNotFoundError(err)) return { notFound: true };
    logger.debug({ err, groupId }, 'getGroupChatHistory probe failed');
    return {};
  }
}

/** Hiển thị tương đối — chỉ để list đọc được. */
export function formatRelativeTime(ts?: number): string {
  if (!ts || !(ts > 0)) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return '';
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m}p`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(ts).toLocaleDateString('vi-VN');
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

export type UndoHandler = (undo: {
  targetMsgId?: string;
  zaloThreadId?: string;
  isSelf?: boolean;
}) => void | Promise<void>;

export class PersonalAccountAdapter {
  private handler: GroupInboundHandler | null = null;
  private undoHandler: UndoHandler | null = null;
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

  onUndo(handler: UndoHandler): void {
    this.undoHandler = handler;
  }

  /** Gọi khi WS đóng hẳn (hết retry) — SessionManager restart tenant. */
  private onClosedHandler: ((code: number, reason: string) => void) | null = null;

  onClosed(handler: (code: number, reason: string) => void): void {
    this.onClosedHandler = handler;
  }

  start(): void {
    if (this.started) return;
    this.api.listener.on('message', (message) => {
      void this.handleMessage(message).catch((err) => {
        logger.error({ err, tenantId: this.tenantId }, 'Personal inbound failed');
      });
    });
    const listener = this.api.listener as typeof this.api.listener & {
      on(event: 'undo', cb: (undo: unknown) => void): void;
    };
    if (typeof listener.on === 'function') {
      try {
        listener.on('undo', (undo) => {
          void this.handleUndo(undo).catch((err) => {
            logger.error({ err, tenantId: this.tenantId }, 'Personal undo failed');
          });
        });
      } catch {
        // một số bản zca-js không emit undo
      }
    }
    this.api.listener.on('disconnected', (code, reason) => {
      logger.warn(
        { tenantId: this.tenantId, code, reason: String(reason) },
        'Personal WS disconnected — zca-js will retry if allowed',
      );
    });
    this.api.listener.on('closed', (code, reason) => {
      logger.error(
        { tenantId: this.tenantId, code, reason: String(reason) },
        'Personal WS closed — listener dead',
      );
      this.started = false;
      this.onClosedHandler?.(Number(code), String(reason));
    });
    this.api.listener.on('error', (err) => {
      logger.warn({ err, tenantId: this.tenantId }, 'Personal WS error');
    });
    // Quan trọng: không bật retryOnClose thì WS đứt = mất hết tin forward
    // Phòng trường hợp option bị lệch
    if (this.api.listener.selfListen !== true) {
      this.api.listener.selfListen = true;
    }
    this.api.listener.start({ retryOnClose: true });
    this.started = true;
    logger.info(
      {
        tenantId: this.tenantId,
        selfListen: Boolean(this.api.listener.selfListen),
      },
      'Personal listener started',
    );
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
    const typeNum = Number(message.type);
    const isGroup =
      message.type === ThreadType.Group || typeNum === ThreadType.Group;
    const isUser =
      message.type === ThreadType.User || typeNum === ThreadType.User;
    if (!isGroup && !isUser) return;
    if (!this.handler) return;

    // Dump raw để bắt format/style (propertyExt thường thiếu styles trên listener)
    void dumpInboundRaw(this.tenantId, message).catch((err) => {
      logger.debug({ err }, 'dumpInboundRaw failed');
    });

    const threadKind = isGroup ? 'group' : 'user';
    const normalized = parseGroupMessage(message, threadKind);
    if (!normalized) {
      logger.debug(
        {
          tenantId: this.tenantId,
          threadId: message.threadId,
          threadKind,
          msgType: message.data?.msgType,
          isSelf: message.isSelf,
        },
        'Skip inbound message (unsupported / empty)',
      );
      return;
    }

    // Chỉ bỏ echo của tin bot vừa gửi qua API (tránh vòng A→B→A).
    // Tin tự gõ trên Zalo (phone/PC) vẫn forward — cần selfListen: true.
    if (normalized.isSelf && this.isEchoOutbound(normalized.groupId, normalized.text)) {
      // Bổ sung cliMsgId cho neo reply tín hiệu (sendMessage chỉ trả msgId)
      const raw = message.data as {
        msgId?: string | number;
        cliMsgId?: string | number;
      };
      if (raw.msgId != null && raw.cliMsgId != null) {
        const { patchSignalOrderCliMsgId } = await import('../db/signal-orders.js');
        patchSignalOrderCliMsgId(
          this.tenantId,
          normalized.groupId,
          String(raw.msgId),
          String(raw.cliMsgId),
        );
        const { setZaloCliMsgId } = await import('../db/message-links.js');
        setZaloCliMsgId(this.tenantId, String(raw.msgId), String(raw.cliMsgId));
      }
      logger.debug(
        { tenantId: this.tenantId, groupId: normalized.groupId },
        'Skip outbound echo',
      );
      return;
    }

    if (normalized.isSelf) {
      logger.info(
        {
          tenantId: this.tenantId,
          threadId: normalized.groupId,
          threadKind: normalized.threadKind,
          messageId: normalized.messageId,
        },
        'Inbound self message — will forward',
      );
    }

    await this.handler(normalized);
  }

  /**
   * Chat 1-1 (bạn bè) — id = userId Zalo.
   * Sắp xếp theo thời gian tin gần nhất (unread / lastActionTime).
   */
  async listFriends(): Promise<
    Array<{ userId: string; name: string; lastActiveAt?: number; pinned?: boolean }>
  > {
    const friends = await this.api.getAllFriends();
    const unreadTs = new Map<string, number>();
    try {
      if (typeof this.api.getUnreadMark === 'function') {
        const unread = await this.api.getUnreadMark();
        for (const c of unread.data?.convsUser ?? []) {
          const id = String(c.fromUid ?? c.id ?? '');
          const ts = normalizeZaloTs(c.ts != null ? Number(c.ts) : undefined);
          if (!id || ts == null) continue;
          unreadTs.set(id, Math.max(unreadTs.get(id) ?? 0, ts));
        }
      }
    } catch (err) {
      logger.warn({ err, tenantId: this.tenantId }, 'getUnreadMark (user) failed');
    }

    const pinned = new Set<string>();
    try {
      if (typeof this.api.getPinConversations === 'function') {
        const pins = await this.api.getPinConversations();
        for (const p of pins.conversations ?? []) {
          const raw = String(p);
          // Pin user thường dạng u<id>
          if (raw.startsWith('u')) pinned.add(raw.slice(1));
          else if (!raw.startsWith('g')) pinned.add(normalizePinId(raw));
        }
      }
    } catch (err) {
      logger.warn({ err, tenantId: this.tenantId }, 'getPinConversations (user) failed');
    }

    const items = (friends ?? []).map((f) => {
      const userId = String(f.userId);
      const name =
        (f.displayName || f.zaloName || f.username || userId).trim() || userId;
      const lastAction = normalizeZaloTs(
        f.lastActionTime != null ? Number(f.lastActionTime) : undefined,
      );
      const lastActiveAt =
        Math.max(unreadTs.get(userId) ?? 0, lastAction ?? 0) || undefined;
      return {
        userId,
        name,
        lastActiveAt,
        pinned: pinned.has(userId),
      };
    });

    // Thời gian giảm dần; không có ts xuống cuối; ghim chỉ đánh dấu, không ưu tiên.
    items.sort((a, b) => {
      const at = a.lastActiveAt ?? 0;
      const bt = b.lastActiveAt ?? 0;
      if (bt !== at) return bt - at;
      return a.name.localeCompare(b.name, 'vi', { sensitivity: 'base' });
    });

    return items;
  }

  async listGroups(): Promise<
    Array<{ groupId: string; name: string; lastActiveAt?: number; pinned?: boolean }>
  > {
    let ids: string[] = [];
    try {
      const all = await this.api.getAllGroups();
      ids = Object.keys(all.gridVerMap ?? {});
    } catch (err) {
      // Một số nick (mới login / API getlg/v4) trả 114 "Tham số không hợp lệ"
      logger.warn(
        { err, tenantId: this.tenantId },
        'getAllGroups failed — fallback groups_cache',
      );
      return listGroupCache(this.tenantId).map((g) => ({
        groupId: g.groupId,
        name: g.name ?? g.groupId,
        lastActiveAt: g.lastSeenAt > 0 ? g.lastSeenAt : undefined,
      }));
    }
    if (ids.length === 0) {
      return listGroupCache(this.tenantId).map((g) => ({
        groupId: g.groupId,
        name: g.name ?? g.groupId,
        lastActiveAt: g.lastSeenAt > 0 ? g.lastSeenAt : undefined,
      }));
    }

    // getGroupInfo dễ 114 nếu gửi quá nhiều id một lần
    const map: Record<string, { name?: string }> = {};
    const chunkSize = 50;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      try {
        const info = await this.api.getGroupInfo(chunk);
        Object.assign(map, info.gridInfoMap ?? {});
      } catch (err) {
        logger.warn(
          { err, tenantId: this.tenantId, chunk: chunk.length },
          'getGroupInfo chunk failed',
        );
      }
    }

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

    const groups = ids.map((id) => {
      const unreadOrCache = lastById.get(id) ?? cached.get(id);
      return {
        groupId: id,
        name: map[id]?.name ?? id,
        lastActiveAt: unreadOrCache && unreadOrCache > 0 ? unreadOrCache : undefined,
        pinned: pinned.has(id),
      };
    });

    // Probe group thiếu ts — ưu tiên getCloudMessage (zca-js ≥ 2.2).
    const cloudApi = this.api as ApiWithCloud;
    const canProbe =
      typeof cloudApi.getCloudMessage === 'function' ||
      typeof this.api.getGroupChatHistory === 'function';
    const hasCloud = typeof cloudApi.getCloudMessage === 'function';
    const missing = groups.filter((g) => !(g.lastActiveAt && g.lastActiveAt > 0));
    const toProbe = missing.slice(0, GROUP_HISTORY_PROBE_LIMIT);

    if (toProbe.length > 0 && canProbe) {
      let consecutiveNotFound = 0;
      let probedOk = 0;
      let aborted = false;
      const byId = new Map(groups.map((g) => [g.groupId, g]));

      await mapPool(toProbe, GROUP_HISTORY_PROBE_CONCURRENCY, async (g) => {
        if (aborted) return;
        const result = await probeGroupLastMessageTs(this.api, g.groupId);
        if (result.notFound) {
          consecutiveNotFound += 1;
          // Chỉ abort sớm khi phải dựa vào getGroupChatHistory (hay 404).
          if (!hasCloud && consecutiveNotFound >= GROUP_HISTORY_PROBE_FAIL_ABORT) {
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
          { tenantId: this.tenantId, probedOk, missing: missing.length, hasCloud },
          'Probed group history for recent order',
        );
      }
    }

    // Thời gian tin gần nhất giảm dần (không ưu tiên ghim).
    groups.sort((a, b) => {
      const at = a.lastActiveAt ?? 0;
      const bt = b.lastActiveAt ?? 0;
      if (bt !== at) return bt - at;
      return a.name.localeCompare(b.name, 'vi', { sensitivity: 'base' });
    });

    return groups;
  }

  private async handleUndo(raw: unknown): Promise<void> {
    if (!this.undoHandler || !raw || typeof raw !== 'object') return;
    const u = raw as {
      data?: { msgId?: string | number; idTo?: string | number };
      threadId?: string;
      isSelf?: boolean;
    };
    const targetMsgId =
      u.data?.msgId != null ? String(u.data.msgId) : undefined;
    const zaloThreadId =
      u.threadId != null
        ? String(u.threadId)
        : u.data?.idTo != null
          ? String(u.data.idTo)
          : undefined;
    await this.undoHandler({
      targetMsgId,
      zaloThreadId,
      isSelf: Boolean(u.isSelf),
    });
  }

  /** Serialize WS old_messages requests (1-1 history). */
  private userHistoryTail: Promise<unknown> = Promise.resolve();

  /**
   * Lịch sử thread (group qua Cloud; 1-1 qua WS requestOldMessages).
   */
  async fetchThreadHistory(
    threadId: string,
    threadKind: 'user' | 'group',
    count = 50,
  ): Promise<{
    messages: NormalizedGroupMessage[];
    meta: {
      pages: number;
      rawCount: number;
      isFiltered: boolean;
      lastMsgId?: string;
      source: 'cloud' | 'ws_old' | 'empty';
    };
  }> {
    if (threadKind === 'user') {
      return this.fetchUserHistory(threadId, count);
    }
    return this.fetchGroupHistory(threadId, count);
  }

  /**
   * Lịch sử group (cũ → mới) qua getCloudMessage / getGroupChatHistory.
   */
  async fetchGroupHistory(
    groupId: string,
    count = 50,
  ): Promise<{
    messages: NormalizedGroupMessage[];
    meta: {
      pages: number;
      rawCount: number;
      isFiltered: boolean;
      lastMsgId?: string;
      source: 'cloud' | 'ws_old' | 'empty';
    };
  }> {
    const want = Math.max(1, Math.min(count, 200));
    const { msgs, pages, isFiltered, lastMsgId, source } =
      await fetchGroupHistoryMessages(this.api, groupId, want);

    msgs.sort((a, b) => {
      const ta =
        normalizeZaloTs(
          a.data?.ts != null ? Number(a.data.ts) : undefined,
        ) ?? 0;
      const tb =
        normalizeZaloTs(
          b.data?.ts != null ? Number(b.data.ts) : undefined,
        ) ?? 0;
      return ta - tb;
    });

    const out: NormalizedGroupMessage[] = [];
    for (const raw of msgs) {
      const normalized = parseGroupMessage(raw, 'group');
      if (normalized) out.push(normalized);
    }

    logger.info(
      {
        tenantId: this.tenantId,
        groupId,
        requested: want,
        got: out.length,
        pages,
        isFiltered,
        lastMsgId,
        source,
      },
      'Fetched Zalo group chat history',
    );

    return {
      messages: out,
      meta: {
        pages,
        rawCount: msgs.length,
        isFiltered,
        lastMsgId,
        source,
      },
    };
  }

  /**
   * Lịch sử 1-1 qua WS `requestOldMessages` (zca-js không có cloud history user).
   * Giới hạn thực tế ~2 tuần tin gần đây trên session.
   */
  async fetchUserHistory(
    userId: string,
    count = 50,
  ): Promise<{
    messages: NormalizedGroupMessage[];
    meta: {
      pages: number;
      rawCount: number;
      isFiltered: boolean;
      lastMsgId?: string;
      source: 'cloud' | 'ws_old' | 'empty';
    };
  }> {
    const want = Math.max(1, Math.min(count, 200));
    const run = () => this.fetchUserHistoryViaWs(userId, want);
    const prev = this.userHistoryTail;
    let release!: () => void;
    this.userHistoryTail = new Promise<void>((r) => {
      release = r;
    });
    await prev.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
    }
  }

  private fetchUserHistoryViaWs(
    userId: string,
    want: number,
  ): Promise<{
    messages: NormalizedGroupMessage[];
    meta: {
      pages: number;
      rawCount: number;
      isFiltered: boolean;
      lastMsgId?: string;
      source: 'cloud' | 'ws_old' | 'empty';
    };
  }> {
    const listener = this.api.listener as typeof this.api.listener & {
      on(
        event: 'old_messages',
        cb: (messages: ZaloListenerMessage[], type: ThreadType) => void,
      ): void;
      off?(
        event: 'old_messages',
        cb: (messages: ZaloListenerMessage[], type: ThreadType) => void,
      ): void;
      removeListener?(
        event: 'old_messages',
        cb: (messages: ZaloListenerMessage[], type: ThreadType) => void,
      ): void;
      requestOldMessages?(
        threadType: ThreadType,
        lastMsgId?: string | null,
      ): void;
    };

    const requestOld = listener.requestOldMessages?.bind(listener);
    if (typeof requestOld !== 'function') {
      return Promise.reject(
        new Error('Listener không hỗ trợ requestOldMessages (cần zca-js mới)'),
      );
    }

    return new Promise((resolve, reject) => {
      const collected: ZaloListenerMessage[] = [];
      const seen = new Set<string>();
      let pages = 0;
      let cursor: string | null = null;
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (idleTimer) clearTimeout(idleTimer);
        const off = listener.off ?? listener.removeListener;
        if (typeof off === 'function') {
          off.call(listener, 'old_messages', onOld);
        }
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();

        collected.sort((a, b) => {
          const ta =
            normalizeZaloTs(
              a.data?.ts != null ? Number(a.data.ts) : undefined,
            ) ?? 0;
          const tb =
            normalizeZaloTs(
              b.data?.ts != null ? Number(b.data.ts) : undefined,
            ) ?? 0;
          return ta - tb;
        });

        const out: NormalizedGroupMessage[] = [];
        for (const raw of collected) {
          const normalized = parseGroupMessage(raw, 'user');
          if (normalized) out.push(normalized);
        }
        const sliced = out.slice(-want);

        logger.info(
          {
            tenantId: this.tenantId,
            userId,
            requested: want,
            got: sliced.length,
            pages,
            source: sliced.length ? 'ws_old' : 'empty',
          },
          'Fetched Zalo 1-1 chat history',
        );

        resolve({
          messages: sliced,
          meta: {
            pages,
            rawCount: collected.length,
            isFiltered: false,
            lastMsgId: cursor ?? undefined,
            source: sliced.length ? 'ws_old' : 'empty',
          },
        });
      };

      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(), 4_000);
      };

      const onOld = (msgs: ZaloListenerMessage[], type: ThreadType) => {
        if (settled) return;
        if (type !== ThreadType.User && Number(type) !== ThreadType.User) {
          return;
        }
        pages += 1;
        armIdle();

        for (const m of msgs) {
          if (String(m.threadId) !== String(userId)) continue;
          const id = m.data?.msgId != null ? String(m.data.msgId) : '';
          if (id) {
            if (seen.has(id)) continue;
            seen.add(id);
          }
          collected.push(m);
        }

        const last = msgs[msgs.length - 1];
        const nextCursor =
          last?.data?.msgId != null ? String(last.data.msgId) : null;

        if (collected.length >= want || msgs.length === 0 || pages >= 15) {
          finish();
          return;
        }
        if (!nextCursor || nextCursor === cursor) {
          finish();
          return;
        }
        cursor = nextCursor;
        try {
          requestOld(ThreadType.User, cursor);
        } catch (err) {
          settled = true;
          cleanup();
          reject(err);
        }
      };

      listener.on('old_messages', onOld);
      armIdle();
      try {
        requestOld(ThreadType.User, null);
      } catch (err) {
        settled = true;
        cleanup();
        reject(err);
      }

      // Hard timeout
      setTimeout(() => {
        if (!settled) finish();
      }, 20_000);
    });
  }

  async undoMessage(params: {
    msgId: string;
    cliMsgId: string;
    threadId: string;
    threadKind?: 'user' | 'group';
  }): Promise<void> {
    const api = this.api as ApiWithCloud;
    if (typeof api.undo !== 'function') {
      throw new Error('API undo không khả dụng');
    }
    const threadType =
      params.threadKind === 'user' ? ThreadType.User : ThreadType.Group;
    await api.undo(
      { msgId: params.msgId, cliMsgId: params.cliMsgId },
      params.threadId,
      threadType,
    );
    logger.info(
      {
        tenantId: this.tenantId,
        threadId: params.threadId,
        msgId: params.msgId,
      },
      'Zalo undo ok',
    );
  }

  sendText(
    threadId: string,
    text: string,
    opts?: {
      styles?: ForwardStyle[];
      mentions?: ForwardMention[];
      quote?: import('zca-js').SendMessageQuote;
      threadKind?: 'user' | 'group';
    },
  ): Promise<{ messageId: string; cliMsgId: string; ts: string }> {
    return this.queue.enqueue(async () => {
      this.markOutbound(threadId, text);
      const styles = opts?.styles?.length ? opts.styles : undefined;
      const mentions = opts?.mentions?.length ? opts.mentions : undefined;
      const quote = opts?.quote;
      const threadType =
        opts?.threadKind === 'user' ? ThreadType.User : ThreadType.Group;
      // clientId trong zca-js = Date.now() — lấy gần đúng trước khi gọi API
      const cliMsgIdGuess = String(Date.now());
      const payload =
        styles || mentions || quote
          ? {
              msg: text,
              ...(styles ? { styles } : {}),
              ...(mentions ? { mentions } : {}),
              ...(quote ? { quote } : {}),
            }
          : text;
      const result = await this.api.sendMessage(payload, threadId, threadType);
      const msg = result.message as
        | { msgId?: string | number; cliMsgId?: string | number }
        | null
        | undefined;
      const messageId = String(msg?.msgId ?? 'ok');
      const cliMsgId =
        msg?.cliMsgId != null ? String(msg.cliMsgId) : cliMsgIdGuess;
      return {
        messageId,
        cliMsgId,
        ts: cliMsgIdGuess,
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
    threadId: string,
    images: Array<{ url: string }>,
    caption = '',
    opts?: { threadKind?: 'user' | 'group' },
  ): Promise<{ messageId: string }> {
    return this.queue.enqueue(async () => {
      const paths: string[] = [];
      try {
        for (const img of images) {
          const buf = await downloadZaloMedia(img.url, this.sessionPath);
          const path = await writeTempImage(buf);
          paths.push(path);
        }
        this.markOutbound(threadId, caption || '[image]');
        const threadType =
          opts?.threadKind === 'user' ? ThreadType.User : ThreadType.Group;
        const result = await this.api.sendMessage(
          {
            msg: caption,
            attachments: paths.length === 1 ? paths[0]! : paths,
          },
          threadId,
          threadType,
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

async function fetchGroupHistoryMessages(
  api: API,
  groupId: string,
  count: number,
): Promise<{
  msgs: ZaloListenerMessage[];
  pages: number;
  isFiltered: boolean;
  lastMsgId?: string;
  source: 'cloud' | 'empty';
}> {
  const cloudApi = api as ApiWithCloud;
  if (typeof cloudApi.getCloudMessage === 'function') {
    try {
      if (typeof api.getGroupInfo === 'function') {
        await api.getGroupInfo(groupId);
      }
    } catch {
      // warm — ignore
    }

    const collected: ZaloListenerMessage[] = [];
    const seen = new Set<string>();
    let lastMsgId: string | undefined;
    let isOld = false;
    let isFiltered = false;
    let pages = 0;
    let finalLastMsgId: string | undefined;

    for (let i = 0; i < 8 && collected.length < count; i++) {
      let page: Awaited<ReturnType<NonNullable<ApiWithCloud['getCloudMessage']>>>;
      try {
        page = lastMsgId
          ? await cloudApi.getCloudMessage(groupId, lastMsgId, { isOld })
          : await cloudApi.getCloudMessage!(groupId);
      } catch (err) {
        const code = (err as { code?: number | string })?.code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code === -69 || /stop retry/i.test(msg)) break;
        throw err;
      }
      pages += 1;
      if (page.isFiltered) isFiltered = true;
      const batch = (page.groupMsgs ?? []) as ZaloListenerMessage[];
      for (const m of batch) {
        const id =
          m && typeof m === 'object' && 'data' in m && m.data?.msgId != null
            ? String(m.data.msgId)
            : '';
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        collected.push(m);
        if (collected.length >= count) break;
      }

      const nextId =
        page.lastMsgId != null && String(page.lastMsgId) !== '0'
          ? String(page.lastMsgId)
          : '';
      finalLastMsgId = nextId || finalLastMsgId;
      const pageIsOldFlag = Number(page.isOld ?? 0) === 1;

      if (!batch.length) {
        if ((page.isFiltered || Number(page.isFiltered)) && nextId && !isOld) {
          lastMsgId = nextId;
          isOld = true;
          continue;
        }
        break;
      }
      if (!nextId || nextId === lastMsgId) break;
      lastMsgId = nextId;
      isOld = pageIsOldFlag;
      if (Number(page.hasMore ?? 0) !== 1 && !pageIsOldFlag) break;
    }

    if (collected.length > 0) {
      return {
        msgs: collected,
        pages,
        isFiltered,
        lastMsgId: finalLastMsgId,
        source: 'cloud',
      };
    }
    return {
      msgs: [],
      pages,
      isFiltered,
      lastMsgId: finalLastMsgId,
      source: 'empty',
    };
  }

  if (typeof api.getGroupChatHistory === 'function') {
    const hist = await api.getGroupChatHistory(groupId, count);
    const msgs = [...(hist.groupMsgs ?? [])] as ZaloListenerMessage[];
    return {
      msgs,
      pages: 1,
      isFiltered: false,
      source: msgs.length ? 'cloud' : 'empty',
    };
  }

  throw new Error(
    'Không có API lịch sử group (cần zca-js ≥ 2.2 với getCloudMessage)',
  );
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
