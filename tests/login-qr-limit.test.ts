import { describe, expect, it } from 'vitest';
import { MAX_QR_SENDS } from '../src/personal/login-qr.js';

describe('QR send limit', () => {
  it('caps auto-resend at 3 total sends', () => {
    expect(MAX_QR_SENDS).toBe(3);
  });

  it('retries only while under the cap', () => {
    const decisions = [1, 2, 3].map((qrSends) => qrSends < MAX_QR_SENDS);
    expect(decisions).toEqual([true, true, false]);
  });
});
