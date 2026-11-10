import { mkdtemp, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionDownloadHeaders } from './session.js';

export async function downloadZaloMedia(
  url: string,
  sessionPath: string,
): Promise<Buffer> {
  const headers = await getSessionDownloadHeaders(sessionPath);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Download media failed: ${res.status} ${res.statusText}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export async function writeTempImage(
  buffer: Buffer,
  ext = 'jpg',
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'zmf-img-'));
  const path = join(dir, `img.${ext}`);
  await writeFile(path, buffer);
  return path;
}

export async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}
