import type { Express, Request, Response } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import { SendQueue } from '../relay/queue.js';

export type BotInbound = {
  zaloUserId: string;
  text: string;
  displayName?: string;
  messageId?: string;
};

type InboundHandler = (msg: BotInbound) => void | Promise<void>;

/**
 * Zalo Bot Platform control-plane adapter.
 * Docs: https://docs.zaloplatforms.com/docs/BOT/create_bot
 */
export class ZaloBotControl {
  private handler: InboundHandler | null = null;
  private readonly queue: SendQueue;
  private readonly apiBase: string;
  private pollAbort = false;
  private pollPromise: Promise<void> | null = null;

  constructor() {
    const env = getEnv();
    this.queue = new SendQueue(300, 30);
    this.apiBase = `https://bot-api.zaloplatforms.com/bot${env.ZALO_BOT_TOKEN}`;
  }

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const transport = getEnv().zaloBotTransport;
    if (transport === 'polling') {
      await this.deleteWebhook();
      this.pollAbort = false;
      this.pollPromise = this.pollLoop();
      logger.info({ transport }, 'Zalo Bot control started (polling)');
      return;
    }
    logger.info({ transport }, 'Zalo Bot control ready (webhook)');
  }

  async stop(): Promise<void> {
    this.pollAbort = true;
    if (this.pollPromise) {
      await this.pollPromise.catch(() => undefined);
      this.pollPromise = null;
    }
    this.handler = null;
  }

  mountWebhook(app: Express): void {
    const path = getEnv().ZALO_BOT_WEBHOOK_PATH;
    app.post(path, (req: Request, res: Response) => {
      if (!this.verifyWebhook(req)) {
        res.sendStatus(401);
        return;
      }
      res.sendStatus(200);
      const msg = normalizeBotUpdate(req.body);
      if (!msg) return;
      void this.dispatch(msg).catch((err) =>
        logger.error({ err }, 'Bot webhook handler failed'),
      );
    });
    logger.info({ path }, 'Zalo bot webhook mounted');
  }

  /** Serve QR images under /qr/:file */
  mountQrStatic(app: Express): void {
    const qrDir = getEnv().QR_DIR;
    app.get('/qr/:file', (req: Request, res: Response) => {
      const file = String(req.params.file ?? '').replace(/[^a-zA-Z0-9._-]/g, '');
      if (!file) {
        res.sendStatus(400);
        return;
      }
      const full = `${qrDir}/${file}`;
      if (!existsSync(full)) {
        res.sendStatus(404);
        return;
      }
      res.type('png');
      createReadStream(full).pipe(res);
    });
  }

  private verifyWebhook(req: Request): boolean {
    const secret = getEnv().ZALO_BOT_WEBHOOK_SECRET;
    if (!secret) return false;
    const header =
      req.get('X-Zalo-Bot-Api-Secret-Token') ||
      req.get('x-zalo-bot-api-secret-token') ||
      '';
    if (header && header === secret) return true;
    const auth = req.get('authorization') || '';
    if (auth === `Bearer ${secret}` || auth === secret) return true;
    logger.warn('Zalo bot webhook rejected — invalid secret');
    return false;
  }

  private async deleteWebhook(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/deleteWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const json = (await res.json()) as { ok?: boolean; description?: string };
      logger.info({ ok: json.ok, description: json.description }, 'Zalo deleteWebhook');
    } catch (err) {
      logger.warn({ err }, 'Zalo deleteWebhook failed — continuing');
    }
  }

  private async pollLoop(): Promise<void> {
    const timeout = getEnv().ZALO_BOT_POLL_TIMEOUT_SEC;
    while (!this.pollAbort) {
      try {
        const res = await fetch(`${this.apiBase}/getUpdates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeout: String(timeout) }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          result?: unknown;
          description?: string;
        };
        if (!res.ok || json.ok === false) {
          logger.warn(
            { status: res.status, description: json.description },
            'Zalo getUpdates non-OK',
          );
          await sleep(2000);
          continue;
        }
        if (json.result == null) continue;
        const updates = Array.isArray(json.result) ? json.result : [json.result];
        for (const update of updates) {
          if (this.pollAbort) break;
          const msg = normalizeBotUpdate(update);
          if (msg) await this.dispatch(msg);
        }
      } catch (err) {
        if (this.pollAbort) break;
        logger.error({ err }, 'Zalo getUpdates poll error');
        await sleep(2000);
      }
    }
  }

  private async dispatch(msg: BotInbound): Promise<void> {
    if (!this.handler) return;
    await this.handler(msg);
  }

  sendText(userId: string, text: string): Promise<void> {
    return this.queue.enqueue(async () => {
      const res = await fetch(`${this.apiBase}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: userId, text }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        description?: string;
        error_code?: number;
      };
      if (!res.ok || json.ok === false) {
        throw new Error(
          `sendMessage failed: ${json.description ?? res.statusText} (${json.error_code ?? res.status})`,
        );
      }
    });
  }

  /**
   * Gửi ảnh QR qua Zalo Bot.
   * API sendPhoto chỉ nhận HTTPS URL — thử lần lượt:
   * 1) PUBLIC_BASE_URL + /sendPhoto
   * 2) upload multipart → me/media/images → lấy URL → /sendPhoto
   * 3) multipart /sendPhoto trực tiếp với file
   * 4) fallback text
   */
  async sendPhoto(userId: string, filePath: string, caption?: string): Promise<void> {
    const errors: string[] = [];

    const publicUrl = publicQrUrl(filePath);
    if (publicUrl) {
      try {
        await this.sendPhotoByUrl(userId, publicUrl, caption);
        return;
      } catch (err) {
        errors.push(`public_url: ${errMsg(err)}`);
        logger.warn({ err, publicUrl }, 'sendPhoto via PUBLIC_BASE_URL failed');
      }
    }

    try {
      const uploadedUrl = await this.uploadImageAndGetUrl(filePath);
      if (uploadedUrl) {
        await this.sendPhotoByUrl(userId, uploadedUrl, caption);
        return;
      }
      errors.push('upload: no url returned');
    } catch (err) {
      errors.push(`upload: ${errMsg(err)}`);
      logger.warn({ err }, 'upload image for sendPhoto failed');
    }

    try {
      await this.sendPhotoMultipart(userId, filePath, caption);
      return;
    } catch (err) {
      errors.push(`multipart: ${errMsg(err)}`);
      logger.warn({ err }, 'multipart sendPhoto failed');
    }

    await this.sendText(
      userId,
      `${caption ? caption + '\n' : ''}` +
        `Không gửi được ảnh QR qua bot.\n` +
        `File: ${filePath}\n` +
        `Cách nhanh: đặt PUBLIC_BASE_URL=https://... (tunnel/ngrok) rồi /login lại.\n` +
        `Hoặc mở file PNG trên máy chạy bot để quét.\n` +
        `(chi tiết: ${errors.join(' | ')})`,
    );
  }

  private sendPhotoByUrl(
    userId: string,
    photoUrl: string,
    caption?: string,
  ): Promise<void> {
    return this.queue.enqueue(async () => {
      const body: Record<string, string> = {
        chat_id: userId,
        photo: photoUrl,
      };
      if (caption?.trim()) body.caption = caption.trim().slice(0, 2000);

      const res = await fetch(`${this.apiBase}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        description?: string;
        error_code?: number;
      };
      if (!res.ok || json.ok === false) {
        throw new Error(
          `sendPhoto failed: ${json.description ?? res.statusText} (${json.error_code ?? res.status})`,
        );
      }
    });
  }

  /** Upload local file → Zalo media → public URL */
  private async uploadImageAndGetUrl(filePath: string): Promise<string | null> {
    const buf = await readFile(filePath);
    const filename = basename(filePath) || 'qr.png';
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)], { type: 'image/png' }), filename);

    const res = await fetch(`${this.apiBase}/me/media/images`, {
      method: 'POST',
      body: form,
    });
    const json = (await res.json()) as {
      ok?: boolean;
      result?: {
        attachment_id?: string;
        url?: string;
        data?: { attachment_id?: string; url?: string };
      };
      description?: string;
    };
    if (!res.ok || json.ok === false) {
      throw new Error(json.description ?? `upload HTTP ${res.status}`);
    }

    const direct =
      json.result?.url ??
      json.result?.data?.url ??
      null;
    if (direct && /^https?:\/\//i.test(direct)) return direct;

    const attachmentId =
      json.result?.attachment_id ?? json.result?.data?.attachment_id;
    if (!attachmentId) return null;

    const metaRes = await fetch(
      `${this.apiBase}/me/media/${encodeURIComponent(attachmentId)}?redirect=true`,
    );
    const meta = (await metaRes.json()) as {
      ok?: boolean;
      result?: { url?: string };
      url?: string;
      description?: string;
    };
    const url = meta.result?.url ?? meta.url ?? null;
    if (url && /^https?:\/\//i.test(url)) return url;
    return null;
  }

  /** Thử gửi file trực tiếp multipart (một số gateway hỗ trợ như Telegram). */
  private sendPhotoMultipart(
    userId: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    return this.queue.enqueue(async () => {
      const buf = await readFile(filePath);
      const filename = basename(filePath) || 'qr.png';
      const form = new FormData();
      form.append('chat_id', userId);
      if (caption?.trim()) form.append('caption', caption.trim().slice(0, 2000));
      form.append('photo', new Blob([new Uint8Array(buf)], { type: 'image/png' }), filename);

      const res = await fetch(`${this.apiBase}/sendPhoto`, {
        method: 'POST',
        body: form,
      });
      const json = (await res.json()) as {
        ok?: boolean;
        description?: string;
        error_code?: number;
      };
      if (!res.ok || json.ok === false) {
        throw new Error(
          `multipart sendPhoto: ${json.description ?? res.statusText} (${json.error_code ?? res.status})`,
        );
      }
    });
  }

  async notifyAdmins(text: string): Promise<void> {
    const { listAdminNotifyIds } = await import('../db/admins.js');
    for (const id of listAdminNotifyIds()) {
      try {
        await this.sendText(id, text);
      } catch (err) {
        logger.warn({ err, id }, 'notifyAdmin failed');
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build public HTTPS URL for a QR file under /qr/:file when PUBLIC_BASE_URL is set. */
export function publicQrUrl(filePath: string): string | null {
  const base = getEnv().PUBLIC_BASE_URL?.trim();
  if (!base) return null;
  const file = basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '');
  if (!file) return null;
  return `${base.replace(/\/$/, '')}/qr/${file}`;
}

export function normalizeBotUpdate(body: unknown): BotInbound | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;

  const message = raw.message as Record<string, unknown> | undefined;
  if (message && typeof message === 'object') {
    const chat = message.chat as Record<string, unknown> | undefined;
    const chatId = chat?.id;
    if (typeof chatId === 'string' || typeof chatId === 'number') {
      const from = message.from as Record<string, unknown> | undefined;
      const name =
        typeof from?.display_name === 'string'
          ? from.display_name
          : typeof from?.first_name === 'string'
            ? from.first_name
            : undefined;
      const messageId = message.message_id != null ? String(message.message_id) : undefined;
      if (typeof message.text === 'string' && message.text) {
        return {
          zaloUserId: String(chatId),
          text: message.text,
          displayName: name,
          messageId,
        };
      }
    }
  }

  if (raw.event_name === 'user_send_text') {
    const sender = raw.sender as Record<string, unknown> | undefined;
    const msg = raw.message as Record<string, unknown> | undefined;
    const text = typeof msg?.text === 'string' ? msg.text : null;
    const id = sender?.id;
    if (text && (typeof id === 'string' || typeof id === 'number')) {
      return {
        zaloUserId: String(id),
        text,
        messageId: msg?.msg_id != null ? String(msg.msg_id) : undefined,
      };
    }
  }

  return null;
}
