import localtunnel from 'localtunnel';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';

let tunnelUrl: string | null = null;
let tunnelPromise: Promise<string> | null = null;
let tunnelClose: (() => void) | null = null;

/**
 * Base URL HTTPS để Zalo fetch ảnh /qr/...
 * Ưu tiên PUBLIC_BASE_URL; không có thì mở localtunnel tới PORT.
 */
export async function getPublicBaseUrl(): Promise<string | null> {
  const env = getEnv();
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');

  if (!env.QR_AUTO_TUNNEL) return null;
  if (tunnelUrl) return tunnelUrl;

  if (!tunnelPromise) {
    tunnelPromise = (async () => {
      const tunnel = await localtunnel({ port: env.PORT });
      tunnelUrl = tunnel.url.replace(/\/$/, '');
      tunnelClose = () => {
        try {
          tunnel.close();
        } catch {
          // ignore
        }
      };
      tunnel.on('close', () => {
        tunnelUrl = null;
        tunnelPromise = null;
        tunnelClose = null;
      });
      tunnel.on('error', (err) => {
        logger.warn({ err }, 'localtunnel error');
      });
      logger.info({ url: tunnelUrl }, 'QR auto-tunnel (localtunnel) ready');
      return tunnelUrl;
    })().catch((err) => {
      tunnelPromise = null;
      tunnelUrl = null;
      throw err;
    });
  }

  return tunnelPromise;
}

export function closePublicTunnel(): void {
  tunnelClose?.();
  tunnelClose = null;
  tunnelUrl = null;
  tunnelPromise = null;
}

export function qrFilePublicUrl(base: string, filePath: string): string {
  const file = filePath.split(/[/\\]/).pop()?.replace(/[^a-zA-Z0-9._-]/g, '') ?? '';
  return `${base.replace(/\/$/, '')}/qr/${file}`;
}
