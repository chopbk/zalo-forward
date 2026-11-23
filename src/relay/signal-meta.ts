/**
 * Nhận diện loại tin tín hiệu + khóa lệnh để reply chuỗi (chờ → khớp → TP/STP).
 * Parse cả format cũ (HCT) lẫn format mới (đã reformat).
 * Kèm field giá/PnL để lưu backtest.
 */

export type SignalKind =
  | 'pending_new'
  | 'pending_update'
  | 'filled'
  | 'tp'
  | 'stp';

export type SignalSide = 'MUA' | 'BÁN';

export type SignalMeta = {
  kind: SignalKind;
  code: string;
  /** Số lệnh [n] — có ở filled / tp / stp */
  ticket?: string;
  side?: SignalSide;
  product?: string;
  /** Khóa lưu tin "chờ" theo mã hợp đồng */
  pendingKey: string;
  /** Khóa lưu tin "đã khớp" theo mã + ticket (nếu có) */
  filledKey?: string;
  /**
   * Sau khi gửi: lưu tin này làm neo reply.
   * - pending_new → pendingKey
   * - filled → filledKey
   */
  storeAs?: 'pending' | 'filled';
  /**
   * Khi gửi: quote neo nào (nếu có trong DB).
   * Ưu tiên filled rồi mới pending.
   */
  quotePrefer: Array<'filled' | 'pending'>;
  /** Giá / PnL trích từ tin — phục vụ backtest */
  entryPrice?: string;
  slPrice?: string;
  tpPrice?: string;
  hitPrice?: string;
  pnlUsd?: string;
  tpLevel?: 'TP1' | 'TP2' | 'TP3';
  signalTime?: string;
};

export function pendingOrderKey(code: string): string {
  return code.toUpperCase();
}

export function filledOrderKey(code: string, ticket: string): string {
  return `${code.toUpperCase()}#${ticket}`;
}

export function parseSignalMeta(text: string): SignalMeta | null {
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

function normSide(raw: string): SignalSide {
  const s = raw.toLowerCase();
  if (s.startsWith('bán') || s.startsWith('ban') || s === 'sell') return 'BÁN';
  return 'MUA';
}

function base(
  kind: SignalKind,
  code: string,
  opts: {
    ticket?: string;
    side?: SignalSide;
    product?: string;
    storeAs?: 'pending' | 'filled';
    quotePrefer: Array<'filled' | 'pending'>;
    entryPrice?: string;
    slPrice?: string;
    tpPrice?: string;
    hitPrice?: string;
    pnlUsd?: string;
    tpLevel?: 'TP1' | 'TP2' | 'TP3';
    signalTime?: string;
  },
): SignalMeta {
  const c = code.toUpperCase();
  return {
    kind,
    code: c,
    ticket: opts.ticket,
    side: opts.side,
    product: opts.product?.trim(),
    pendingKey: pendingOrderKey(c),
    filledKey: opts.ticket ? filledOrderKey(c, opts.ticket) : undefined,
    storeAs: opts.storeAs,
    quotePrefer: opts.quotePrefer,
    entryPrice: opts.entryPrice,
    slPrice: opts.slPrice,
    tpPrice: opts.tpPrice,
    hitPrice: opts.hitPrice,
    pnlUsd: opts.pnlUsd,
    tpLevel: opts.tpLevel,
    signalTime: opts.signalTime,
  };
}

function tryPendingNew(t: string): SignalMeta | null {
  // Cũ: 🔹/🔸 [Chờ] Mua|Bán product (CODE) tại giá X
  let m = t.match(
    /^(?:🔹|🔸)\s*\[Chờ\]\s*(Mua|Bán)\s+(.+?)\s+\(([A-Z0-9]+)\)\s+tại giá\s+([\d.,]+)\s*\n+Dừng lỗ:\s*([\d.,]+)\s*[·•.]\s*Chốt lời:\s*([\d.,]+)/i,
  );
  if (m) {
    return base('pending_new', m[3]!, {
      side: normSide(m[1]!),
      product: m[2]!,
      storeAs: 'pending',
      quotePrefer: [],
      entryPrice: m[4]!,
      slPrice: m[5]!,
      tpPrice: m[6]!,
    });
  }
  m = t.match(
    /^(?:🔹|🔸)\s*\[Chờ\]\s*(Mua|Bán)\s+.+\(([A-Z0-9]+)\)/i,
  );
  if (m) {
    return base('pending_new', m[2]!, {
      side: normSide(m[1]!),
      storeAs: 'pending',
      quotePrefer: [],
    });
  }
  // Mới: 🔔 [CHỜ MUA|BÁN] product (CODE)
  m = t.match(
    /^🔔\s*\[CHỜ\s+(MUA|BÁN)\]\s+(.+?)\s+\(([A-Z0-9]+)\)\s*\n+[\s\S]*?Giá chờ[^:]*:\s*([\d.,]+)\s*\n+🛑\s*Dừng lỗ:\s*([\d.,]+)\s*\n+🎯\s*Chốt lời:\s*([\d.,]+)/i,
  );
  if (m) {
    return base('pending_new', m[3]!, {
      side: normSide(m[1]!),
      product: m[2]!,
      storeAs: 'pending',
      quotePrefer: [],
      entryPrice: m[4]!,
      slPrice: m[5]!,
      tpPrice: m[6]!,
    });
  }
  m = t.match(/^🔔\s*\[CHỜ\s+(MUA|BÁN)\]\s+.+\(([A-Z0-9]+)\)/i);
  if (m) {
    return base('pending_new', m[2]!, {
      side: normSide(m[1]!),
      storeAs: 'pending',
      quotePrefer: [],
    });
  }
  return null;
}

function tryPendingUpdate(t: string): SignalMeta | null {
  let m = t.match(
    /^(?:🔹|🔸)\s*\[Chờ\]\s*Cập nhật lệnh chờ\s+(mua|bán)\s+(.+?)\s+\(([A-Z0-9]+)\)\.?\s*\n+Giá chờ:\s*([\d.,]+)(?:\s*\(cũ\s*[\d.,]+\))?\s*\n+Dừng lỗ:\s*([\d.,]+)(?:\s*\(cũ\s*[\d.,]+\))?\s*\n+Chốt lời:\s*([\d.,]+)/i,
  );
  if (m) {
    return base('pending_update', m[3]!, {
      side: normSide(m[1]!),
      product: m[2]!,
      quotePrefer: ['pending'],
      entryPrice: m[4]!,
      slPrice: m[5]!,
      tpPrice: m[6]!,
    });
  }
  m = t.match(
    /^(?:🔹|🔸)\s*\[Chờ\]\s*Cập nhật lệnh chờ\s+(mua|bán)\s+.+\(([A-Z0-9]+)\)/i,
  );
  if (m) {
    return base('pending_update', m[2]!, {
      side: normSide(m[1]!),
      quotePrefer: ['pending'],
    });
  }
  m = t.match(
    /^🔄\s*\[CẬP NHẬT LỆNH CHỜ\s+(MUA|BÁN)\]\s+(.+?)\s+\(([A-Z0-9]+)\)\s*\n+[\s\S]*?Giá[^:]*:\s*([\d.,]+)(?:\s*\(Cũ:[^)]+\))?\s*\n+🛑\s*Dừng lỗ:\s*([\d.,]+)(?:\s*\(Cũ:[^)]+\))?\s*\n+🎯\s*Chốt lời:\s*([\d.,]+)/i,
  );
  if (m) {
    return base('pending_update', m[3]!, {
      side: normSide(m[1]!),
      product: m[2]!,
      quotePrefer: ['pending'],
      entryPrice: m[4]!,
      slPrice: m[5]!,
      tpPrice: m[6]!,
    });
  }
  m = t.match(
    /^🔄\s*\[CẬP NHẬT LỆNH CHỜ\s+(MUA|BÁN)\]\s+.+\(([A-Z0-9]+)\)/i,
  );
  if (m) {
    return base('pending_update', m[2]!, {
      side: normSide(m[1]!),
      quotePrefer: ['pending'],
    });
  }
  return null;
}

function tryFilled(t: string): SignalMeta | null {
  let m = t.match(
    /^🔵\s*(Mua|Bán)\s+(.+?)\s+\(([A-Z0-9]+)\)\s*\[(\d+)\]\s+tại giá\s+([\d.,]+)\s*\n+❌\s*Dừng lỗ:\s*([\d.,]+)/i,
  );
  if (m) {
    const time = t.match(/Lúc\s+(\d{1,2}:\d{2}:\d{2})/i)?.[1];
    return base('filled', m[3]!, {
      side: normSide(m[1]!),
      product: m[2]!,
      ticket: m[4]!,
      storeAs: 'filled',
      quotePrefer: ['pending'],
      entryPrice: m[5]!,
      slPrice: m[6]!,
      signalTime: time,
    });
  }
  m = t.match(
    /^🔵\s*(?:Mua|Bán)\s+.+\(([A-Z0-9]+)\)\s*\[(\d+)\]\s+tại giá/i,
  );
  if (m) {
    return base('filled', m[1]!, {
      ticket: m[2]!,
      storeAs: 'filled',
      quotePrefer: ['pending'],
    });
  }
  m = t.match(
    /^🔵\s*\[LỆNH\s+(MUA|BÁN)\s+ĐÃ KHỚP\]\s+(.+?)\s+\(([A-Z0-9]+)\)\s*\[(\d+)\]\s*\n+💰\s*Giá vào lệnh:\s*([\d.,]+)\s*\n+❌\s*Dừng lỗ:\s*([\d.,]+)/i,
  );
  if (m) {
    const time = t.match(/🕒\s*Thời gian:\s*(\d{1,2}:\d{2}:\d{2})/i)?.[1];
    return base('filled', m[3]!, {
      side: normSide(m[1]!),
      product: m[2]!,
      ticket: m[4]!,
      storeAs: 'filled',
      quotePrefer: ['pending'],
      entryPrice: m[5]!,
      slPrice: m[6]!,
      signalTime: time,
    });
  }
  m = t.match(
    /^🔵\s*\[LỆNH\s+(MUA|BÁN)\s+ĐÃ KHỚP\]\s+.+\(([A-Z0-9]+)\)\s*\[(\d+)\]/i,
  );
  if (m) {
    return base('filled', m[2]!, {
      side: normSide(m[1]!),
      ticket: m[3]!,
      storeAs: 'filled',
      quotePrefer: ['pending'],
    });
  }
  return null;
}

function tryTakeProfit(t: string): SignalMeta | null {
  // Cũ — ✅ là BMP nên {1,3} OK
  let m = t.match(
    /^(?:✅{1,3})\s+(.+?)\s+\(([A-Z0-9]+)\)\s*\[(\d+)\]\s+đạt\s+(TP[123])\s+tại\s+([\d.,]+)\s*\(giá vào\s+([\d.,]+)\)\.?\s*\n+Lãi:\s*([+\-−][\d.,]+)\s*USD\/Lot/i,
  );
  if (m) {
    const time = t.match(/Lúc\s+(\d{1,2}:\d{2}:\d{2})/i)?.[1];
    return base('tp', m[2]!, {
      product: m[1]!,
      ticket: m[3]!,
      quotePrefer: ['filled', 'pending'],
      tpLevel: m[4]!.toUpperCase() as 'TP1' | 'TP2' | 'TP3',
      hitPrice: m[5]!,
      entryPrice: m[6]!,
      pnlUsd: m[7]!,
      signalTime: time,
    });
  }
  m = t.match(
    /^(?:✅{1,3})\s+.+\(([A-Z0-9]+)\)\s*\[(\d+)\]\s+đạt\s+TP[123]/i,
  );
  if (m) {
    return base('tp', m[1]!, {
      ticket: m[2]!,
      quotePrefer: ['filled', 'pending'],
    });
  }
  // Mới — không dùng {n} trên emoji ngoài BMP
  m = t.match(
    /^(?:🏆🏆🏆|🎯🎯|🎯)\s*\[(?:CHỐT LỜI (TP[12])|HOÀN THÀNH (TP3))\]\s+(.+?)\s+\(([A-Z0-9]+)\)\s*\[(\d+)\]\s*\n+✅\s*Giá khớp TP[123]:\s*([\d.,]+)\s*\n+💰\s*Giá vào lệnh:\s*([\d.,]+)\s*\n+🟢\s*Lợi nhuận:\s*([+\-−][\d.,]+)\s*USD\/Lot/i,
  );
  if (m) {
    const level = (m[1] || m[2] || 'TP1').toUpperCase() as 'TP1' | 'TP2' | 'TP3';
    const time = t.match(/🕒\s*Thời gian:\s*(\d{1,2}:\d{2}:\d{2})/i)?.[1];
    return base('tp', m[4]!, {
      product: m[3]!,
      ticket: m[5]!,
      quotePrefer: ['filled', 'pending'],
      tpLevel: level,
      hitPrice: m[6]!,
      entryPrice: m[7]!,
      pnlUsd: m[8]!,
      signalTime: time,
    });
  }
  m = t.match(
    /^(?:🏆🏆🏆|🎯🎯|🎯)\s*\[(?:CHỐT LỜI TP[12]|HOÀN THÀNH TP3)\]\s+.+\(([A-Z0-9]+)\)\s*\[(\d+)\]/i,
  );
  if (m) {
    return base('tp', m[1]!, {
      ticket: m[2]!,
      quotePrefer: ['filled', 'pending'],
    });
  }
  return null;
}

function tryStopLoss(t: string): SignalMeta | null {
  let m = t.match(
    /^(?:❌|⛔)\s+(.+?)\s+\(([A-Z0-9]+)\)\s*\[(\d+)\]\s+chạm dừng lỗ\s+tại\s+([\d.,]+)\s*\(giá vào\s+([\d.,]+)\)\.?\s*\n+Lỗ:\s*([+\-−][\d.,]+)\s*USD\/Lot/i,
  );
  if (m) {
    const time = t.match(/Lúc\s+(\d{1,2}:\d{2}:\d{2})/i)?.[1];
    return base('stp', m[2]!, {
      product: m[1]!,
      ticket: m[3]!,
      quotePrefer: ['filled', 'pending'],
      hitPrice: m[4]!,
      entryPrice: m[5]!,
      pnlUsd: m[6]!,
      slPrice: m[4]!,
      signalTime: time,
    });
  }
  m = t.match(
    /^(?:❌|⛔)\s+.+\(([A-Z0-9]+)\)\s*\[(\d+)\]\s+chạm dừng lỗ/i,
  );
  if (m) {
    return base('stp', m[1]!, {
      ticket: m[2]!,
      quotePrefer: ['filled', 'pending'],
    });
  }
  m = t.match(
    /^⛔\s*\[CHẠM DỪNG LỖ\]\s+(.+?)\s+\(([A-Z0-9]+)\)\s*\[(\d+)\]\s*\n+🛑\s*Giá dừng lỗ:\s*([\d.,]+)\s*\n+💰\s*Giá vào lệnh:\s*([\d.,]+)\s*\n+🔴\s*Lỗ:\s*([+\-−][\d.,]+)\s*USD\/Lot/i,
  );
  if (m) {
    const time = t.match(/🕒\s*Thời gian:\s*(\d{1,2}:\d{2}:\d{2})/i)?.[1];
    return base('stp', m[2]!, {
      product: m[1]!,
      ticket: m[3]!,
      quotePrefer: ['filled', 'pending'],
      slPrice: m[4]!,
      hitPrice: m[4]!,
      entryPrice: m[5]!,
      pnlUsd: m[6]!,
      signalTime: time,
    });
  }
  m = t.match(
    /^⛔\s*\[CHẠM DỪNG LỖ\]\s+.+\(([A-Z0-9]+)\)\s*\[(\d+)\]/i,
  );
  if (m) {
    return base('stp', m[1]!, {
      ticket: m[2]!,
      quotePrefer: ['filled', 'pending'],
    });
  }
  return null;
}
