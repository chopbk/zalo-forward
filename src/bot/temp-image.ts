import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import logger from '../config/logger.js';

/**
 * Upload ảnh lên host tạm (HTTPS) để Zalo Bot sendPhoto có URL.
 * QR login nhạy cảm — chỉ dùng host TTL ngắn; user nên quét ngay.
 */
export async function uploadTempImageUrl(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  if (buf.length === 0) throw new Error('QR file is empty');

  const errors: string[] = [];
  const filename = basename(filePath) || 'qr.png';

  try {
    const url = await uploadLitterbox(buf, filename);
    if (url) return url;
    errors.push('litterbox: empty');
  } catch (err) {
    errors.push(`litterbox: ${err instanceof Error ? err.message : String(err)}`);
    logger.warn({ err }, 'litterbox upload failed');
  }

  try {
    const url = await uploadZeroXZero(buf, filename);
    if (url) return url;
    errors.push('0x0: empty');
  } catch (err) {
    errors.push(`0x0: ${err instanceof Error ? err.message : String(err)}`);
    logger.warn({ err }, '0x0.st upload failed');
  }

  throw new Error(`temp host failed: ${errors.join(' | ')}`);
}

function pngBlob(buf: Buffer): Blob {
  return new Blob([new Uint8Array(buf)], { type: 'image/png' });
}

async function uploadLitterbox(buf: Buffer, filename: string): Promise<string | null> {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('time', '1h');
  form.append('fileToUpload', pngBlob(buf), filename);

  const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
    method: 'POST',
    body: form,
  });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  if (!/^https?:\/\//i.test(text)) throw new Error(`unexpected response: ${text.slice(0, 120)}`);
  return text;
}

async function uploadZeroXZero(buf: Buffer, filename: string): Promise<string | null> {
  const form = new FormData();
  form.append('file', pngBlob(buf), filename);

  const res = await fetch('https://0x0.st', {
    method: 'POST',
    body: form,
    headers: {
      'User-Agent': 'zalo-message-forward/0.1',
    },
  });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  if (!/^https?:\/\//i.test(text)) throw new Error(`unexpected response: ${text.slice(0, 120)}`);
  return text;
}
