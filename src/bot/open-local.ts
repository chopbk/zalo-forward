import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { platform } from 'node:os';
import logger from '../config/logger.js';

/** Mở file ảnh QR trên máy chạy bot (macOS/Linux/Windows). */
export function openLocalFile(filePath: string): void {
  const abs = resolve(filePath);
  const os = platform();
  try {
    if (os === 'darwin') {
      spawn('open', [abs], { detached: true, stdio: 'ignore' }).unref();
    } else if (os === 'win32') {
      spawn('cmd', ['/c', 'start', '', abs], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else {
      spawn('xdg-open', [abs], { detached: true, stdio: 'ignore' }).unref();
    }
    logger.info({ abs }, 'Opened QR locally');
  } catch (err) {
    logger.warn({ err, abs }, 'Failed to open QR locally');
  }
}
