import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import logger from '../config/logger.js';

/**
 * Upload ảnh lên host tạm (HTTPS) — race vài host, lấy URL đầu tiên thành công.
 */
export async function uploadTempImageUrl(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  if (buf.length === 0) throw new Error('QR file is empty');
  const filename = basename(filePath) || 'qr.png';

  const attempts = [
    withTimeout(uploadCatbox(buf, filename), 12_000, 'catbox'),
    withTimeout(uploadLitterbox(buf, filename), 12_000, 'litterbox'),
    withTimeout(uploadZeroXZero(buf, filename), 12_000, '0x0'),
  ];

  const errors: string[] = [];
  const result = await Promise.any(
    attempts.map((p) =>
      p.catch((err) => {
        errors.push(err instanceof Error ? err.message : String(err));
        throw err;
      }),
    ),
  ).catch(() => null);

  if (result) return result;
  throw new Error(`temp host failed: ${errors.join(' | ')}`);
}

function pngBlob(buf: Buffer): Blob {
  return new Blob([new Uint8Array(buf)], { type: 'image/png' });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

/** catbox.moe — thường nhanh hơn litterbox */
async function uploadCatbox(buf: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', pngBlob(buf), filename);
  const res = await fetch('https://catbox.moe/user/api.php', {
    method: 'POST',
    body: form,
  });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`catbox HTTP ${res.status}: ${text.slice(0, 80)}`);
  if (!/^https?:\/\//i.test(text)) throw new Error(`catbox bad: ${text.slice(0, 80)}`);
  logger.info({ host: 'catbox' }, 'QR temp upload ok');
  return text;
}

async function uploadLitterbox(buf: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('time', '1h');
  form.append('fileToUpload', pngBlob(buf), filename);
  const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
    method: 'POST',
    body: form,
  });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`litterbox HTTP ${res.status}: ${text.slice(0, 80)}`);
  if (!/^https?:\/\//i.test(text)) throw new Error(`litterbox bad: ${text.slice(0, 80)}`);
  logger.info({ host: 'litterbox' }, 'QR temp upload ok');
  return text;
}

async function uploadZeroXZero(buf: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('file', pngBlob(buf), filename);
  const res = await fetch('https://0x0.st', {
    method: 'POST',
    body: form,
    headers: { 'User-Agent': 'zalo-message-forward/0.1' },
  });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`0x0 HTTP ${res.status}: ${text.slice(0, 80)}`);
  if (!/^https?:\/\//i.test(text)) throw new Error(`0x0 bad: ${text.slice(0, 80)}`);
  logger.info({ host: '0x0' }, 'QR temp upload ok');
  return text;
}
