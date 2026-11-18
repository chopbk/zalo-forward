import { describe, expect, it } from 'vitest';
import { parseSignalMeta } from '../src/relay/signal-meta.js';

describe('parseSignalMeta', () => {
  it('pending new old+new', () => {
    const old = parseSignalMeta(
      `🔸 [Chờ] Bán Dầu đậu tương tháng 1 (ZLEF27) tại giá 61.700
Dừng lỗ: 62.458 · Chốt lời: 59.578
A/C đặt lệnh Sell Limit nhé ạ!`,
    );
    expect(old).toMatchObject({
      kind: 'pending_new',
      code: 'ZLEF27',
      pendingKey: 'ZLEF27',
      storeAs: 'pending',
      quotePrefer: [],
    });

    const neu = parseSignalMeta(
      `🔔 [CHỜ BÁN] DẦU ĐẬU TƯƠNG THÁNG 1 (ZLEF27)

🔸 Giá chờ bán (Sell Limit): 61.700`,
    );
    expect(neu?.kind).toBe('pending_new');
    expect(neu?.storeAs).toBe('pending');
  });

  it('pending update quotes pending', () => {
    const m = parseSignalMeta(
      `🔸 [Chờ] Cập nhật lệnh chờ bán Robusta tháng 1 (LRCF27).
Giá chờ: 3135.0 (cũ 3162.9)
Dừng lỗ: 3226.6
Chốt lời: 2878.6`,
    );
    expect(m).toMatchObject({
      kind: 'pending_update',
      code: 'LRCF27',
      quotePrefer: ['pending'],
    });
    expect(m?.storeAs).toBeUndefined();
  });

  it('filled stores filled and quotes pending', () => {
    const m = parseSignalMeta(
      `🔵 Mua Đậu tương tháng 1 (ZSEF27) [1] tại giá 1229.50
❌ Dừng lỗ: 1223.26 (-312.00 USD/Lot)
✅ TP1: 1231.99 (+124.50 USD/Lot)
Lúc 23:36:50`,
    );
    expect(m).toMatchObject({
      kind: 'filled',
      code: 'ZSEF27',
      ticket: '1',
      filledKey: 'ZSEF27#1',
      storeAs: 'filled',
      quotePrefer: ['pending'],
    });
  });

  it('tp3 quotes filled then pending + prices', () => {
    const old = parseSignalMeta(
      `✅✅✅ Bạch kim tháng 1 (PLEF27) [1] đạt TP3 tại 1406.85 (giá vào 1468.11).
Lãi: +3,063.00 USD/Lot
Lúc 09:06:05`,
    );
    expect(old).toMatchObject({
      kind: 'tp',
      code: 'PLEF27',
      ticket: '1',
      filledKey: 'PLEF27#1',
      quotePrefer: ['filled', 'pending'],
      tpLevel: 'TP3',
      hitPrice: '1406.85',
      entryPrice: '1468.11',
      pnlUsd: '+3,063.00',
      signalTime: '09:06:05',
    });

    const neu = parseSignalMeta(
      `🏆🏆🏆 [HOÀN THÀNH TP3] DẦU ĐẬU TƯƠNG T1 (ZLEF27) [1]

✅ Giá khớp TP3: 61.104
💰 Giá vào lệnh: 62.520
🟢 Lợi nhuận: +849.60 USD/Lot

🕒 Thời gian: 22:03:21`,
    );
    expect(neu).toMatchObject({
      kind: 'tp',
      code: 'ZLEF27',
      ticket: '1',
      filledKey: 'ZLEF27#1',
      quotePrefer: ['filled', 'pending'],
      tpLevel: 'TP3',
      hitPrice: '61.104',
      entryPrice: '62.520',
      pnlUsd: '+849.60',
      signalTime: '22:03:21',
    });
  });

  it('stp quotes filled', () => {
    const m = parseSignalMeta(
      `❌ Đậu tương tháng 1 (ZSEF27) [1] chạm dừng lỗ tại 1223.26 (giá vào 1229.50).
Lỗ: -312.00 USD/Lot
Lúc 14:05:48`,
    );
    expect(m).toMatchObject({
      kind: 'stp',
      filledKey: 'ZSEF27#1',
      quotePrefer: ['filled', 'pending'],
    });
  });

  it('ignores unrelated', () => {
    expect(parseSignalMeta('hello')).toBeNull();
  });
});
