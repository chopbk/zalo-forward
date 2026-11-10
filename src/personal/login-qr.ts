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

export type QrLoginCallbacks = {
  onQrReady: (qrFilePath: string) => void | Promise<void>;
  onScanned?: (displayName?: string) => void | Promise<void>;
  onExpired?: () => void | Promise<void>;
  onDeclined?: () => void | Promise<void>;
  onSuccess: (session: ZaloSessionFile, path: string, ownId: string) => void | Promise<void>;
  onError?: (err: unknown) => void | Promise<void>;
};

/**
 * Start QR login for a tenant. Resolves when GotLoginInfo saved, or rejects on hard fail.
 */
export async function startQrLogin(
  tenantId: number,
  cbs: QrLoginCallbacks,
): Promise<void> {
  const env = getEnv();
  await mkdir(env.QR_DIR, { recursive: true });
  const qrPath = join(env.QR_DIR, `tenant-${tenantId}.png`);
  const sessionPath = sessionPathForTenant(tenantId);

  const zalo = new Zalo({ imageMetadataGetter });
  let saved = false;

  const api = await zalo.loginQR({}, (event) => {
    switch (event.type) {
      case LoginQRCallbackEventType.QRCodeGenerated:
        void event.actions.saveToFile(qrPath).then(() => cbs.onQrReady(qrPath));
        break;
      case LoginQRCallbackEventType.QRCodeScanned:
        void cbs.onScanned?.(event.data.display_name);
        break;
      case LoginQRCallbackEventType.QRCodeExpired:
        void cbs.onExpired?.();
        event.actions.retry();
        break;
      case LoginQRCallbackEventType.QRCodeDeclined:
        void cbs.onDeclined?.();
        break;
      case LoginQRCallbackEventType.GotLoginInfo:
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
    // QR flow continues asynchronously via callbacks until success/decline;
    // do not throw — user still scanning.
    logger.info({ tenantId }, 'QR login waiting for scan');
  }
}
