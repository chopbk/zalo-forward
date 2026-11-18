/**
 * Đổi format tin tín hiệu hàng hóa (cũ → mới) khi khớp mẫu.
 * Không khớp → trả về null (giữ nguyên tin gốc).
 */

const MONTH_RE = /tháng\s+(\d{1,2})/i;

/** 1226.54 → 1,226.54 ; giữ số thập phân gốc; bỏ .00 thừa ở PnL riêng. */
export function formatPrice(raw: string): string {
  const cleaned = raw.replace(/,/g, '').trim();
  const neg = cleaned.startsWith('-') || cleaned.startsWith('−');
  const body = cleaned.replace(/^[-−]/, '');
  if (!/^\d+(\.\d+)?$/.test(body)) return raw.trim();
  const [intPart, dec] = body.split('.');
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const out = dec != null ? `${withSep}.${dec}` : withSep;
  return neg ? `−${out}` : out;
}

/** +124.50 giữ; +499.00 → +499 ; -312.00 → −312 */
export function formatPnl(raw: string): string {
  const m = raw.trim().match(/^([+\-−]?)([\d,]+(?:\.\d+)?)/);
  if (!m) return raw.trim();
  const signChar = m[1] === '-' || m[1] === '−' ? '−' : m[1] === '+' ? '+' : '';
  let num = m[2].replace(/,/g, '');
  if (/\.0+$/.test(num)) num = num.replace(/\.0+$/, '');
  else if (/\.(\d*?)0+$/.test(num) && !/\.\d*[1-9]0$/.test(num)) {
    // keep meaningful decimals like .50; strip only all-zero decimals already handled
  }
  // Strip trailing .00 only (already), keep .50
  const formatted = formatPrice(num);
  return `${signChar}${formatted}`;
}

function upperVi(s: string): string {
  return s.trim().toLocaleUpperCase('vi-VN');
}

/** "Đậu tương tháng 1" → pending: "ĐẬU TƯƠNG THÁNG 1" | short: "ĐẬU TƯƠNG T1" */
export function formatProductName(name: string, style: 'pending' | 'short'): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (style === 'pending') {
    return upperVi(n);
  }
  return upperVi(n.replace(MONTH_RE, (_m, d: string) => `T${d}`));
}

function sideLabel(side: string): { muaBan: 'MUA' | 'BÁN'; limit: 'Buy Limit' | 'Sell Limit' } {
  const s = side.toLowerCase();
  if (s.startsWith('bán') || s.startsWith('ban') || s === 'sell') {
    return { muaBan: 'BÁN', limit: 'Sell Limit' };
  }
  return { muaBan: 'MUA', limit: 'Buy Limit' };
}

export function reformatSignalMessage(text: string): string | null {
  const t = text.replace(/\r\n/g, '\n').trim();
  if (!t) return null;

  return (
    tryPendingNew(t) ??
    tryPendingUpdate(t) ??
    tryFilled(t) ??
    tryTakeProfit(t) ??
    tryStopLoss(t)
  );
}

/** 🔹 [Chờ] Mua ... tại giá ... */
function tryPendingNew(t: string): string | null {
  const m = t.match(
    /^🔹\s*\[Chờ\]\s*(Mua|Bán)\s+(.+?)\s+\(([A-Z0-9]+)\)\s+tại giá\s+([\d.,]+)\s*\n+Dừng lỗ:\s*([\d.,]+)\s*[·•.]\s*Chốt lời:\s*([\d.,]+)\s*\n+([\s\S]+)$/i,
  );
  if (!m) return null;
  const side = sideLabel(m[1]!);
  const product = formatProductName(m[2]!, 'pending');
  const code = m[3]!;
  const entry = formatPrice(m[4]!);
  const sl = formatPrice(m[5]!);
  const tp = formatPrice(m[6]!);
  const limitWord = side.limit;
  const waitLabel = side.muaBan === 'MUA' ? 'chờ mua' : 'chờ bán';
  const emoji = side.muaBan === 'MUA' ? '🟢' : '🔸';

  return [
    `🔔 [CHỜ ${side.muaBan}] ${product} (${code})`,
    '',
    `${emoji} Giá ${waitLabel} (${limitWord}): ${entry}`,
    `🛑 Dừng lỗ: ${sl}`,
    `🎯 Chốt lời: ${tp}`,
    '',
    `📌 A/C tiến hành đặt lệnh ${limitWord} theo mức giá trên, đồng thời thiết lập Dừng lỗ và Chốt lời tương ứng nhé ạ`,
  ].join('\n');
}

/** 🔸 [Chờ] Cập nhật lệnh chờ bán ... */
function tryPendingUpdate(t: string): string | null {
  const m = t.match(
    /^🔸\s*\[Chờ\]\s*Cập nhật lệnh chờ\s+(mua|bán)\s+(.+?)\s+\(([A-Z0-9]+)\)\.?\s*\n+Giá chờ:\s*([\d.,]+)\s*\(cũ\s*([\d.,]+)\)\s*\n+Dừng lỗ:\s*([\d.,]+)\s*\n+Chốt lời:\s*([\d.,]+)(?:\s*\(cũ\s*([\d.,]+)\))?\s*\n+([\s\S]+)$/i,
  );
  if (!m) return null;
  const side = sideLabel(m[1]!);
  const product = formatProductName(m[2]!, 'short');
  const code = m[3]!;
  const price = formatPrice(m[4]!);
  const priceOld = formatPrice(m[5]!);
  const sl = formatPrice(m[6]!);
  const tp = formatPrice(m[7]!);
  const tpOld = m[8] ? formatPrice(m[8]) : null;

  const tpLine = tpOld
    ? `🎯 Chốt lời: ${tp} (Cũ: ${tpOld})`
    : `🎯 Chốt lời: ${tp}`;

  return [
    `🔄 [CẬP NHẬT LỆNH CHỜ ${side.muaBan}] ${product} (${code})`,
    '',
    `🔸 Giá ${side.limit}: ${price} (Cũ: ${priceOld})`,
    `🛑 Dừng lỗ: ${sl}`,
    tpLine,
    '',
    `📌 A/C vui lòng điều chỉnh lệnh ${side.limit}, Dừng lỗ và Chốt lời theo các mức giá mới bên trên nhé ạ`,
  ].join('\n');
}

/** 🔵 Mua ... [n] tại giá ... */
function tryFilled(t: string): string | null {
  const m = t.match(
    /^🔵\s*(Mua|Bán)\s+(.+?)\s+\(([A-Z0-9]+)\)\s*\[(\d+)\]\s+tại giá\s+([\d.,]+)\s*\n+❌\s*Dừng lỗ:\s*([\d.,]+)\s*\(([+\-−][\d.,]+)\s*USD\/Lot\)\s*\n+((?:✅\s*TP\d+:\s*[\d.,]+\s*\([+\-−][\d.,]+\s*USD\/Lot\)\s*\n?)+)\s*Lúc\s+(\d{1,2}:\d{2}:\d{2})\s*$/i,
  );
  if (!m) return null;
  const side = sideLabel(m[1]!);
  const product = formatProductName(m[2]!, 'short');
  const code = m[3]!;
  const ticket = m[4]!;
  const entry = formatPrice(m[5]!);
  const sl = formatPrice(m[6]!);
  const slPnl = formatPnl(m[7]!);
  const tpBlock = m[8]!;
  const time = m[9]!;

  const tpLines: string[] = [];
  const tpRe = /✅\s*TP(\d+):\s*([\d.,]+)\s*\(([+\-−][\d.,]+)\s*USD\/Lot\)/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tpRe.exec(tpBlock))) {
    tpLines.push(
      `🎯 TP${tm[1]}: ${formatPrice(tm[2]!)} (${formatPnl(tm[3]!)} USD/Lot)`,
    );
  }
  if (tpLines.length === 0) return null;

  return [
    `🔵 [LỆNH ${side.muaBan} ĐÃ KHỚP] ${product} (${code}) [${ticket}]`,
    '',
    `💰 Giá vào lệnh: ${entry}`,
    `❌ Dừng lỗ: ${sl} (${slPnl} USD/Lot)`,
    '',
    ...tpLines,
    '',
    `🕒 Thời gian: ${time}`,
  ].join('\n');
}

/** ✅ / ✅✅ / ✅✅✅ ... đạt TPn */
function tryTakeProfit(t: string): string | null {
  const m = t.match(
    /^(✅{1,3})\s+(.+?)\s+\(([A-Z0-9]+)\)\s*\[(\d+)\]\s+đạt\s+(TP[123])\s+tại\s+([\d.,]+)\s*\(giá vào\s+([\d.,]+)\)\.?\s*\n+Lãi:\s*([+\-−][\d.,]+)\s*USD\/Lot\s*\n+([\s\S]*?)Lúc\s+(\d{1,2}:\d{2}:\d{2})\s*$/i,
  );
  if (!m) return null;
  const level = m[5]!.toUpperCase() as 'TP1' | 'TP2' | 'TP3';
  const product = formatProductName(m[2]!, 'short');
  const code = m[3]!;
  const ticket = m[4]!;
  const hit = formatPrice(m[6]!);
  const entry = formatPrice(m[7]!);
  const pnl = formatPnl(m[8]!);
  const time = m[10]!;

  if (level === 'TP1') {
    return [
      `🎯 [CHỐT LỜI TP1] ${product} (${code}) [${ticket}]`,
      '',
      `✅ Giá khớp TP1: ${hit}`,
      `💰 Giá vào lệnh: ${entry}`,
      `🟢 Lợi nhuận: ${pnl} USD/Lot`,
      '',
      `🕒 Thời gian: ${time}`,
      '',
      `🎉 Chúc mừng A/C đã chốt lời thành công`,
    ].join('\n');
  }
  if (level === 'TP2') {
    return [
      `🎯🎯 [CHỐT LỜI TP2] ${product} (${code}) [${ticket}]`,
      '',
      `✅ Giá khớp TP2: ${hit}`,
      `💰 Giá vào lệnh: ${entry}`,
      `🟢 Lợi nhuận: ${pnl} USD/Lot`,
      '',
      `🕒 Thời gian: ${time}`,
      '',
      `🎉 Chúc mừng A/C tiếp tục chốt lời thành công`,
    ].join('\n');
  }
  return [
    `🏆🏆🏆 [HOÀN THÀNH TP3] ${product} (${code}) [${ticket}]`,
    '',
    `✅ Giá khớp TP3: ${hit}`,
    `💰 Giá vào lệnh: ${entry}`,
    `🟢 Lợi nhuận: ${pnl} USD/Lot`,
    '',
    `🎯 Toàn bộ vị thế đã được tất toán`,
    '',
    `🎉 Chúc mừng Anh/Chị đã chốt lời thành công`,
    '',
    `🕒 Thời gian: ${time}`,
  ].join('\n');
}

/**
 * STP chi tiết:
 * ❌ Đậu tương tháng 1 (ZSEF27) [1] chạm dừng lỗ tại 1223.26 (giá vào 1229.50).
 * Lỗ: -312.00 USD/Lot
 * Lúc 14:05:48
 *
 * STP ngắn: ⛔ ... chạm dừng lỗ. ...
 */
function tryStopLoss(t: string): string | null {
  const detailed = t.match(
    /^[❌⛔]\s+(.+?)\s+\(([A-Z0-9]+)\)\s*\[(\d+)\]\s+chạm dừng lỗ\s+tại\s+([\d.,]+)\s*\(giá vào\s+([\d.,]+)\)\.?\s*\n+Lỗ:\s*([+\-−][\d.,]+)\s*USD\/Lot\s*\n+Lúc\s+(\d{1,2}:\d{2}:\d{2})\s*$/i,
  );
  if (detailed) {
    const product = formatProductName(detailed[1]!, 'short');
    const code = detailed[2]!;
    const ticket = detailed[3]!;
    const sl = formatPrice(detailed[4]!);
    const entry = formatPrice(detailed[5]!);
    const loss = formatPnl(detailed[6]!);
    const time = detailed[7]!;
    return [
      `⛔ [CHẠM DỪNG LỖ] ${product} (${code}) [${ticket}]`,
      '',
      `🛑 Giá dừng lỗ: ${sl}`,
      `💰 Giá vào lệnh: ${entry}`,
      `🔴 Lỗ: ${loss} USD/Lot`,
      '',
      `🕒 Thời gian: ${time}`,
      '',
      `💙 HCT tiếp tục theo dõi thị trường và chờ đợi cơ hội giao dịch tốt hơn. Mong A/C giữ vững kỷ luật giao dịch`,
    ].join('\n');
  }

  const simple = t.match(
    /^[⛔❌]\s+(.+?)\s+\(([A-Z0-9]+)\)\s*\[(\d+)\]\s+chạm dừng lỗ\.?\s*(.*)$/is,
  );
  if (!simple) return null;
  const product = formatProductName(simple[1]!, 'short');
  const code = simple[2]!;
  const ticket = simple[3]!;

  return [
    `⛔ [CHẠM DỪNG LỖ] ${product} (${code}) [${ticket}]`,
    '',
    `🛑 Lệnh đã chạm mức Stop Loss.`,
    `📌 Vị thế được đóng theo mức dừng lỗ.`,
    '',
    `💙 HCT tiếp tục theo dõi thị trường và chờ đợi cơ hội giao dịch tốt hơn. Mong A/C giữ vững kỷ luật giao dịch`,
  ].join('\n');
}
