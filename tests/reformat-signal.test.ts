import { describe, expect, it } from 'vitest';
import {
  formatPnl,
  formatPrice,
  formatProductName,
  reformatSignalMessage,
} from '../src/relay/reformat-signal.js';

describe('format helpers', () => {
  it('formats prices with thousands separators', () => {
    expect(formatPrice('1226.54')).toBe('1,226.54');
    expect(formatPrice('3135.0')).toBe('3,135.0');
    expect(formatPrice('62.318')).toBe('62.318');
    expect(formatPrice('1406.85')).toBe('1,406.85');
  });

  it('formats pnl stripping .00', () => {
    expect(formatPnl('-312.00')).toBe('−312');
    expect(formatPnl('+499.00')).toBe('+499');
    expect(formatPnl('+124.50')).toBe('+124.50');
    expect(formatPnl('+3,063.00')).toBe('+3,063');
  });

  it('formats product names', () => {
    expect(formatProductName('Đậu tương tháng 1', 'pending')).toBe('ĐẬU TƯƠNG THÁNG 1');
    expect(formatProductName('Đậu tương tháng 1', 'short')).toBe('ĐẬU TƯƠNG T1');
    expect(formatProductName('Lúa mỳ tháng 12', 'short')).toBe('LÚA MỲ T12');
  });
});

describe('reformatSignalMessage', () => {
  it('pending new buy', () => {
    const old = `🔹 [Chờ] Mua Đậu tương tháng 1 (ZSEF27) tại giá 1226.54
Dừng lỗ: 1223.26 · Chốt lời: 1235.72
A/C đặt lệnh Buy Limit nhé ạ!`;
    expect(reformatSignalMessage(old)).toBe(
      `🔔 [CHỜ MUA] ĐẬU TƯƠNG THÁNG 1 (ZSEF27)

🟢 Giá chờ mua (Buy Limit): 1,226.54
🛑 Dừng lỗ: 1,223.26
🎯 Chốt lời: 1,235.72

📌 A/C tiến hành đặt lệnh Buy Limit theo mức giá trên, đồng thời thiết lập Dừng lỗ và Chốt lời tương ứng nhé ạ`,
    );
  });

  it('pending new sell with orange diamond', () => {
    const old = `🔸 [Chờ] Bán Dầu đậu tương tháng 1 (ZLEF27) tại giá 61.700
Dừng lỗ: 62.458 · Chốt lời: 59.578
A/C đặt lệnh Sell Limit nhé ạ!`;
    expect(reformatSignalMessage(old)).toBe(
      `🔔 [CHỜ BÁN] DẦU ĐẬU TƯƠNG THÁNG 1 (ZLEF27)

🔸 Giá chờ bán (Sell Limit): 61.700
🛑 Dừng lỗ: 62.458
🎯 Chốt lời: 59.578

📌 A/C tiến hành đặt lệnh Sell Limit theo mức giá trên, đồng thời thiết lập Dừng lỗ và Chốt lời tương ứng nhé ạ`,
    );
  });

  it('pending update sell', () => {
    const old = `🔸 [Chờ] Cập nhật lệnh chờ bán Robusta tháng 1 (LRCF27).
Giá chờ: 3135.0 (cũ 3162.9)
Dừng lỗ: 3226.6
Chốt lời: 2878.6 (cũ 2984.6)
A/C sửa lệnh Sell Limit, Dừng lỗ và Chốt lời theo các mức mới nhé ạ!`;
    expect(reformatSignalMessage(old)).toBe(
      `🔄 [CẬP NHẬT LỆNH CHỜ BÁN] ROBUSTA T1 (LRCF27)

🔸 Giá Sell Limit: 3,135.0 (Cũ: 3,162.9)
🛑 Dừng lỗ: 3,226.6
🎯 Chốt lời: 2,878.6 (Cũ: 2,984.6)

📌 A/C vui lòng điều chỉnh lệnh Sell Limit, Dừng lỗ và Chốt lời theo các mức giá mới bên trên nhé ạ`,
    );
  });

  it('pending update with old prices on all lines', () => {
    const old = `🔸 [Chờ] Cập nhật lệnh chờ bán Bạc micro tháng 3 (SILH27).
Giá chờ: 47.088 (cũ 47.083)
Dừng lỗ: 47.991 (cũ 48.118)
Chốt lời: 44.560 (cũ 44.185)
A/C sửa lệnh Sell Limit, Dừng lỗ và Chốt lời theo các mức mới nhé ạ!`;
    expect(reformatSignalMessage(old)).toBe(
      `🔄 [CẬP NHẬT LỆNH CHỜ BÁN] BẠC MICRO T3 (SILH27)

🔸 Giá Sell Limit: 47.088 (Cũ: 47.083)
🛑 Dừng lỗ: 47.991 (Cũ: 48.118)
🎯 Chốt lời: 44.560 (Cũ: 44.185)

📌 A/C vui lòng điều chỉnh lệnh Sell Limit, Dừng lỗ và Chốt lời theo các mức giá mới bên trên nhé ạ`,
    );
  });

  it('filled buy', () => {
    const old = `🔵 Mua Đậu tương tháng 1 (ZSEF27) [1] tại giá 1229.50
❌ Dừng lỗ: 1223.26 (-312.00 USD/Lot)
✅ TP1: 1231.99 (+124.50 USD/Lot)
✅ TP2: 1239.48 (+499.00 USD/Lot)
✅ TP3: 1246.97 (+873.50 USD/Lot)
Lúc 23:36:50`;
    expect(reformatSignalMessage(old)).toBe(
      `🔵 [LỆNH MUA ĐÃ KHỚP] ĐẬU TƯƠNG T1 (ZSEF27) [1]

💰 Giá vào lệnh: 1,229.50
❌ Dừng lỗ: 1,223.26 (−312 USD/Lot)

🎯 TP1: 1,231.99 (+124.50 USD/Lot)
🎯 TP2: 1,239.48 (+499 USD/Lot)
🎯 TP3: 1,246.97 (+873.50 USD/Lot)

🕒 Thời gian: 23:36:50`,
    );
  });

  it('tp1', () => {
    const old = `✅ Dầu đậu tương tháng 1 (ZLEF27) [1] đạt TP1 tại 62.318 (giá vào 62.520).
Lãi: +121.20 USD/Lot
Lúc 23:52:51`;
    expect(reformatSignalMessage(old)).toBe(
      `🎯 [CHỐT LỜI TP1] DẦU ĐẬU TƯƠNG T1 (ZLEF27) [1]

✅ Giá khớp TP1: 62.318
💰 Giá vào lệnh: 62.520
🟢 Lợi nhuận: +121.20 USD/Lot

🕒 Thời gian: 23:52:51

🎉 Chúc mừng A/C đã chốt lời thành công`,
    );
  });

  it('tp2', () => {
    const old = `✅✅ Đồng micro tháng 3 (MHGH27) [2] đạt TP2 tại 602.15 (giá vào 611.60).
Lãi: +236.25 USD/Lot
Lúc 09:42:00`;
    expect(reformatSignalMessage(old)).toBe(
      `🎯🎯 [CHỐT LỜI TP2] ĐỒNG MICRO T3 (MHGH27) [2]

✅ Giá khớp TP2: 602.15
💰 Giá vào lệnh: 611.60
🟢 Lợi nhuận: +236.25 USD/Lot

🕒 Thời gian: 09:42:00

🎉 Chúc mừng A/C tiếp tục chốt lời thành công`,
    );
  });

  it('tp3', () => {
    const old = `✅✅✅ Bạch kim tháng 1 (PLEF27) [1] đạt TP3 tại 1406.85 (giá vào 1468.11).
Lãi: +3,063.00 USD/Lot
Toàn bộ vị thế đã được tất toán. Chúc mừng Anh/Chị!
Lúc 09:06:05`;
    expect(reformatSignalMessage(old)).toBe(
      `🏆🏆🏆 [HOÀN THÀNH TP3] BẠCH KIM T1 (PLEF27) [1]

✅ Giá khớp TP3: 1,406.85
💰 Giá vào lệnh: 1,468.11
🟢 Lợi nhuận: +3,063 USD/Lot

🎯 Toàn bộ vị thế đã được tất toán

🎉 Chúc mừng Anh/Chị đã chốt lời thành công

🕒 Thời gian: 09:06:05`,
    );
  });

  it('stop loss simple', () => {
    const old = `⛔ Lúa mỳ tháng 12 (ZWAZ26) [2] chạm dừng lỗ. Chờ cơ hội tốt hơn.`;
    expect(reformatSignalMessage(old)).toBe(
      `⛔ [CHẠM DỪNG LỖ] LÚA MỲ T12 (ZWAZ26) [2]

🛑 Lệnh đã chạm mức Stop Loss.
📌 Vị thế được đóng theo mức dừng lỗ.

💙 HCT tiếp tục theo dõi thị trường và chờ đợi cơ hội giao dịch tốt hơn. Mong A/C giữ vững kỷ luật giao dịch`,
    );
  });

  it('stop loss detailed with price and pnl', () => {
    const old = `❌ Đậu tương tháng 1 (ZSEF27) [1] chạm dừng lỗ tại 1223.26 (giá vào 1229.50).
Lỗ: -312.00 USD/Lot
Lúc 14:05:48`;
    expect(reformatSignalMessage(old)).toBe(
      `⛔ [CHẠM DỪNG LỖ] ĐẬU TƯƠNG T1 (ZSEF27) [1]

🛑 Giá dừng lỗ: 1,223.26
💰 Giá vào lệnh: 1,229.50
🔴 Lỗ: −312 USD/Lot

🕒 Thời gian: 14:05:48

💙 HCT tiếp tục theo dõi thị trường và chờ đợi cơ hội giao dịch tốt hơn. Mong A/C giữ vững kỷ luật giao dịch`,
    );
  });

  it('leaves unrelated text alone', () => {
    expect(reformatSignalMessage('hello world')).toBeNull();
    expect(reformatSignalMessage('🔔 [CHỜ MUA] already new')).toBeNull();
  });
});
