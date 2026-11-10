import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env.js';
import { publicQrUrl } from '../src/bot/adapter.js';

afterEach(() => {
  delete process.env.PUBLIC_BASE_URL;
  resetEnvCache();
});

describe('publicQrUrl', () => {
  it('returns null without PUBLIC_BASE_URL', () => {
    process.env.ZALO_BOT_TOKEN = 't';
    process.env.ADMIN_SETUP_PASSWORD = 'p';
    resetEnvCache();
    expect(publicQrUrl('data/qr/tenant-1.png')).toBeNull();
  });

  it('builds /qr URL', () => {
    process.env.ZALO_BOT_TOKEN = 't';
    process.env.ADMIN_SETUP_PASSWORD = 'p';
    process.env.PUBLIC_BASE_URL = 'https://example.com/';
    resetEnvCache();
    expect(publicQrUrl('data/qr/tenant-1.png')).toBe(
      'https://example.com/qr/tenant-1.png',
    );
  });
});
