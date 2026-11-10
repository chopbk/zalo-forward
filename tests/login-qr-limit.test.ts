import { describe, expect, it } from 'vitest';
import { isQrLoginActive, MAX_QR_SENDS, stopQrLogin } from '../src/personal/login-qr.js';

describe('QR send limit', () => {
  it('caps auto-resend at 3 total sends', () => {
    expect(MAX_QR_SENDS).toBe(3);
  });

  it('retries only while under the cap', () => {
    const decisions = [1, 2, 3].map((qrSends) => qrSends < MAX_QR_SENDS);
    expect(decisions).toEqual([true, true, false]);
  });

  it('stopQrLogin is no-op when idle', () => {
    expect(isQrLoginActive(999991)).toBe(false);
    expect(stopQrLogin(999991)).toBe(false);
  });
});
