import dns from 'node:dns';
import https from 'node:https';
import http from 'node:http';
import logger from '../config/logger.js';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // older node
}

export async function downloadUrlToBuffer(
  url: string,
  opts?: { timeoutMs?: number; headers?: Record<string, string> },
): Promise<Buffer> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const headers = opts?.headers ?? {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  };

  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }

    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        family: 4,
        servername: parsed.hostname,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          void downloadUrlToBuffer(res.headers.location, opts).then(resolve, reject);
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode ?? '?'} downloading media`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Download timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

export async function downloadMany(
  urls: string[],
): Promise<{ buffers: Buffer[]; failed: string[] }> {
  const buffers: Buffer[] = [];
  const failed: string[] = [];
  for (const url of urls) {
    try {
      buffers.push(await downloadUrlToBuffer(url));
    } catch (err) {
      logger.warn({ err, url: url.slice(0, 100) }, 'Media download failed');
      failed.push(url);
    }
  }
  return { buffers, failed };
}
