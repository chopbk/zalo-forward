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

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = 'name' in err ? String((err as { name?: unknown }).name) : '';
  const message = err instanceof Error ? err.message : String(err);
  return /LoginQRAborted/i.test(name) || /aborted|Operation aborted/i.test(message);
}

/**
 * Start QR login in background — KHÔNG block bot poll loop.
 * Gọi /stop để abort; hết hạn tối đa MAX_QR_SENDS lần gửi ảnh.
 */
export function startQrLogin(tenantId: number, cbs: QrLoginCallbacks): void {
  if (activeQrLogins.has(tenantId)) {
    stopQrLogin(tenantId);
  }

  let stopped = false;
  let settled = false; // decline / max / success — abort chỉ để settle promise
  let qrSends = 0;
  let abortFn: (() => void) | null = null;

  const clearActive = (): void => {
    activeQrLogins.delete(tenantId);
  };

  activeQrLogins.set(tenantId, {
    abort: () => {
      stopped = true;
      try {
        abortFn?.();
      } catch {
        // ignore
      }
    },
  });

  void (async () => {
    const env = getEnv();
    try {
      await mkdir(env.QR_DIR, { recursive: true });
      const qrPath = join(env.QR_DIR, `tenant-${tenantId}.png`);
      const sessionPath = sessionPathForTenant(tenantId);
      const zalo = new Zalo({ imageMetadataGetter });

      const api = await zalo.loginQR({}, (event) => {
        if (stopped) {
          clearActive();
          try {
            event.actions?.abort?.();
          } catch {
            // ignore
          }
          return;
        }

        if (event.actions && typeof event.actions.abort === 'function') {
          abortFn = event.actions.abort;
        }

        switch (event.type) {
          case LoginQRCallbackEventType.QRCodeGenerated:
            qrSends += 1;
            void event.actions.saveToFile(qrPath).then(() => {
              if (stopped || settled) return;
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
              settled = true;
              clearActive();
              logger.info({ tenantId, qrSends }, 'QR login stopped after max sends');
              event.actions.abort();
            }
            break;
          }
          case LoginQRCallbackEventType.QRCodeDeclined:
            settled = true;
            clearActive();
            void cbs.onDeclined?.();
            // loginQR không resolve khi decline + callback → abort để kết thúc promise
            try {
              event.actions.abort();
            } catch {
              // ignore
            }
            break;
          case LoginQRCallbackEventType.GotLoginInfo:
            settled = true;
            clearActive();
            void (async () => {
              try {
                const session: ZaloSessionFile = {
                  cookie: event.data.cookie,
                  imei: event.data.imei,
                  userAgent: event.data.userAgent,
                };
                await saveSessionAtomic(session, sessionPath);
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

      try {
        api.listener.stop();
      } catch {
        // ignore
      }
    } catch (err) {
      clearActive();
      if (stopped || settled || isAbortError(err)) {
        logger.info({ tenantId, stopped, settled }, 'QR login ended');
        return;
      }
      logger.error({ err, tenantId }, 'QR login failed');
      await cbs.onError?.(err);
    }
  })();

  logger.info({ tenantId }, 'QR login started (background)');
}
