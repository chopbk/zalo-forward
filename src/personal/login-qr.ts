import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LoginQRCallbackEventType, Zalo } from 'zca-js';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import {
  imageMetadataGetter,
  saveSessionAtomic,
  sessionPathForTenant,
  type ZaloSessionFile,
} from './session.js';

/** Số lần gửi ảnh QR tối đa mỗi lần /login (kể cả mã đầu). */
export const MAX_QR_SENDS = 3;

export type QrExpiredInfo = {
  attempt: number;
  maxAttempts: number;
  willRetry: boolean;
};

export type QrLoginCallbacks = {
  onQrReady: (qrFilePath: string, attempt: number) => void | Promise<void>;
  onScanned?: (displayName?: string) => void | Promise<void>;
  onExpired?: (info: QrExpiredInfo) => void | Promise<void>;
  onDeclined?: () => void | Promise<void>;
  onSuccess: (session: ZaloSessionFile, path: string, ownId: string) => void | Promise<void>;
  onError?: (err: unknown) => void | Promise<void>;
};

type ActiveQrLogin = {
  abort: () => void;
};

const activeQrLogins = new Map<number, ActiveQrLogin>();

/** Có phiên /login QR đang chờ quét không. */
export function isQrLoginActive(tenantId: number): boolean {
  return activeQrLogins.has(tenantId);
}

/**
 * Hủy phiên QR login đang chạy (/stop).
 * @returns true nếu có phiên bị dừng.
 */
export function stopQrLogin(tenantId: number): boolean {
  const active = activeQrLogins.get(tenantId);
  if (!active) return false;
  try {
    active.abort();
  } catch (err) {
    logger.warn({ err, tenantId }, 'QR login abort threw');
  }
  activeQrLogins.delete(tenantId);
  logger.info({ tenantId }, 'QR login stopped by user');
  return true;
}

/**
 * Start QR login for a tenant. Resolves when GotLoginInfo saved, or rejects on hard fail.
 * QR hết hạn chỉ auto-retry tới MAX_QR_SENDS lần gửi ảnh — tránh spam khi user không quét.
 * Gõ /stop để abort sớm.
 */
export async function startQrLogin(
  tenantId: number,
  cbs: QrLoginCallbacks,
): Promise<void> {
  const env = getEnv();
  await mkdir(env.QR_DIR, { recursive: true });
  const qrPath = join(env.QR_DIR, `tenant-${tenantId}.png`);
  const sessionPath = sessionPathForTenant(tenantId);

  // /login lại trong lúc đang chờ → dừng phiên cũ trước
  if (activeQrLogins.has(tenantId)) {
    stopQrLogin(tenantId);
  }

  const zalo = new Zalo({ imageMetadataGetter });
  let saved = false;
  let qrSends = 0;
  let stopped = false;

  const clearActive = (): void => {
    const cur = activeQrLogins.get(tenantId);
    if (cur) activeQrLogins.delete(tenantId);
  };

  const rememberAbort = (abortFn: () => void): void => {
    activeQrLogins.set(tenantId, {
      abort: () => {
        stopped = true;
        abortFn();
      },
    });
  };

  const api = await zalo.loginQR({}, (event) => {
    if (stopped) {
      clearActive();
      try {
        event.actions.abort();
      } catch {
        // ignore
      }
      return;
    }
    if ('actions' in event && typeof event.actions.abort === 'function') {
      rememberAbort(event.actions.abort);
    }

    switch (event.type) {
      case LoginQRCallbackEventType.QRCodeGenerated:
        qrSends += 1;
        void event.actions.saveToFile(qrPath).then(() => {
          if (stopped) return;
          return cbs.onQrReady(qrPath, qrSends);
        });
        break;
      case LoginQRCallbackEventType.QRCodeScanned:
        void cbs.onScanned?.(event.data.display_name);
        break;
      case LoginQRCallbackEventType.QRCodeExpired: {
        const willRetry = qrSends < MAX_QR_SENDS;
        void cbs.onExpired?.({
          attempt: qrSends,
          maxAttempts: MAX_QR_SENDS,
          willRetry,
        });
        if (willRetry) {
          event.actions.retry();
        } else {
          logger.info({ tenantId, qrSends }, 'QR login stopped after max sends');
          clearActive();
          event.actions.abort();
        }
        break;
      }
      case LoginQRCallbackEventType.QRCodeDeclined:
        clearActive();
        void cbs.onDeclined?.();
        break;
      case LoginQRCallbackEventType.GotLoginInfo:
        clearActive();
        void (async () => {
          try {
            const session: ZaloSessionFile = {
              cookie: event.data.cookie,
              imei: event.data.imei,
              userAgent: event.data.userAgent,
            };
            await saveSessionAtomic(session, sessionPath);
            saved = true;
            // Login again to get ownId cleanly
            const logged = await new Zalo({ imageMetadataGetter }).login(session);
            const ownId = logged.getOwnId();
            try {
              logged.listener.stop();
            } catch {
              // ignore
            }
            await cbs.onSuccess(session, sessionPath, ownId);
          } catch (err) {
            logger.error({ err, tenantId }, 'QR login save failed');
            await cbs.onError?.(err);
          }
        })();
        break;
      default:
        break;
    }
  });

  if (!api) {
    clearActive();
    throw new Error('Login QR failed');
  }

  // Wait briefly for GotLoginInfo; caller may keep process alive via callbacks
  await new Promise((r) => setTimeout(r, 500));
  try {
    api.listener.stop();
  } catch {
    // ignore
  }

  if (!saved) {
    // QR flow continues asynchronously via callbacks until success/decline/stop;
    // do not throw — user still scanning.
    logger.info({ tenantId }, 'QR login waiting for scan');
  }
}
