import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';

/**
 * Upload anh len host tam (HTTPS) — race nhieu host.
 * VPS thuong bi chan catbox/0x0/telegra → uu tien freeimage + imgbb (neu co key).
 */
export async function uploadTempImageUrl(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  if (buf.length === 0) throw new Error('QR file is empty');
  const filename = basename(filePath) || 'qr.png';

  const attempts: Array<Promise<string>> = [
    withTimeout(uploadFreeImage(buf), 15_000, 'freeimage'),
    withTimeout(uploadTelegraPh(buf, filename), 15_000, 'telegra'),
    withTimeout(uploadCatbox(buf, filename), 15_000, 'catbox'),
    withTimeout(uploadLitterbox(buf, filename), 15_000, 'litterbox'),
    withTimeout(uploadZeroXZero(buf, filename), 15_000, '0x0'),
  ];

  const imgbbKey = getEnv().IMGBB_API_KEY?.trim();
  if (imgbbKey) {
    attempts.unshift(withTimeout(uploadImgbb(buf, imgbbKey), 15_000, 'imgbb'));
  }

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

/** Public demo key tu freeimage.host docs — du cho QR tam. */
const FREEIMAGE_DEMO_KEY = '6d207e02198a847aa98d0a2a901485a5';

async function uploadFreeImage(buf: Buffer): Promise<string> {
  const form = new FormData();
  form.append('source', buf.toString('base64'));
  form.append('type', 'base64');
  form.append('action', 'upload');
  const key = FREEIMAGE_DEMO_KEY;
  const res = await fetch(`https://freeimage.host/api/1/upload?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    body: form,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; zmf/0.1)' },
  });
  const json = (await res.json()) as {
    status_code?: number;
    image?: { url?: string; display_url?: string };
    error?: { message?: string };
    status_txt?: string;
  };
  const url = json.image?.url ?? json.image?.display_url;
  if (!res.ok || !url || !/^https?:\/\//i.test(url)) {
    throw new Error(`freeimage: ${json.error?.message ?? json.status_txt ?? res.status}`);
  }
  logger.info({ host: 'freeimage' }, 'QR temp upload ok');
  return url;
}

async function uploadTelegraPh(buf: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('file', pngBlob(buf), filename);
  const res = await fetch('https://telegra.ph/upload', {
    method: 'POST',
    body: form,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; zmf/0.1)' },
  });
  const json = (await res.json()) as Array<{ src?: string }> | { error?: string };
  if (!res.ok || !Array.isArray(json) || !json[0]?.src) {
    const detail =
      typeof json === 'object' ? JSON.stringify(json).slice(0, 100) : String(res.status);
    throw new Error(`telegra bad: ${detail}`);
  }
  const path = json[0].src;
  const src = path.startsWith('http') ? path : `https://telegra.ph${path}`;
  logger.info({ host: 'telegra.ph', src }, 'QR temp upload ok');
  return src;
}

async function uploadImgbb(buf: Buffer, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append('image', buf.toString('base64'));
  const res = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    body: form,
  });
  const json = (await res.json()) as {
    success?: boolean;
    data?: { url?: string; display_url?: string };
    error?: { message?: string };
  };
  const url = json.data?.display_url ?? json.data?.url;
  if (!json.success || !url) {
    throw new Error(`imgbb: ${json.error?.message ?? 'upload failed'}`);
  }
  logger.info({ host: 'imgbb' }, 'QR temp upload ok');
  return url;
}

async function uploadCatbox(buf: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', pngBlob(buf), filename);
  const res = await fetch('https://catbox.moe/user/api.php', {
    method: 'POST',
    body: form,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; zmf/0.1)' },
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
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; zmf/0.1)' },
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
