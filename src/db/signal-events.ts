import { getDb } from './client.js';
import type { SignalKind, SignalMeta, SignalSide } from '../relay/signal-meta.js';

export type InsertSignalEventInput = {
  tenantId: number;
  sourceGroupId: string;
  sourceMessageId: string;
  sourceTs?: number;
  destGroupId: string;
  destMessageId?: string | null;
  senderName?: string;
  rawText: string;
  forwardedText: string;
  reformatted: boolean;
  signal: SignalMeta | null;
};

export type SignalEventRow = {
  id: number;
  tenantId: number;
  sourceGroupId: string;
  sourceMessageId: string;
  sourceTs: number | null;
  destGroupId: string;
  destMessageId: string | null;
  senderName: string | null;
  kind: SignalKind | 'other';
  code: string | null;
  ticket: string | null;
  side: SignalSide | null;
  product: string | null;
  orderKey: string | null;
  entryPrice: string | null;
  slPrice: string | null;
  tpPrice: string | null;
  hitPrice: string | null;
  pnlUsd: string | null;
  tpLevel: string | null;
  signalTime: string | null;
  rawText: string;
  forwardedText: string;
  reformatted: boolean;
  createdAt: string;
};

function orderKeyOf(signal: SignalMeta | null): string | null {
  if (!signal) return null;
  return signal.filledKey ?? signal.pendingKey;
}

/** Lưu mỗi lần forward (1 nguồn × 1 đích). Phục vụ backtest / dry-run. */
export function insertSignalEvent(input: InsertSignalEventInput): number {
  const s = input.signal;
  const info = getDb()
    .prepare(
      `INSERT INTO signal_events (
         tenant_id, source_group_id, source_message_id, source_ts,
         dest_group_id, dest_message_id, sender_name,
         kind, code, ticket, side, product, order_key,
         entry_price, sl_price, tp_price, hit_price, pnl_usd, tp_level, signal_time,
         raw_text, forwarded_text, reformatted, parsed_json
       ) VALUES (
         ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?
       )
       ON CONFLICT(tenant_id, source_message_id, dest_group_id) DO UPDATE SET
         dest_message_id = COALESCE(excluded.dest_message_id, signal_events.dest_message_id),
         forwarded_text = excluded.forwarded_text,
         reformatted = excluded.reformatted,
         kind = excluded.kind,
         code = excluded.code,
         ticket = excluded.ticket,
         side = excluded.side,
         product = excluded.product,
         order_key = excluded.order_key,
         entry_price = excluded.entry_price,
         sl_price = excluded.sl_price,
         tp_price = excluded.tp_price,
         hit_price = excluded.hit_price,
         pnl_usd = excluded.pnl_usd,
         tp_level = excluded.tp_level,
         signal_time = excluded.signal_time,
         parsed_json = excluded.parsed_json`,
    )
    .run(
      input.tenantId,
      input.sourceGroupId,
      input.sourceMessageId,
      input.sourceTs ?? null,
      input.destGroupId,
      input.destMessageId ?? null,
      input.senderName ?? null,
      s?.kind ?? 'other',
      s?.code ?? null,
      s?.ticket ?? null,
      s?.side ?? null,
      s?.product ?? null,
      orderKeyOf(s),
      s?.entryPrice ?? null,
      s?.slPrice ?? null,
      s?.tpPrice ?? null,
      s?.hitPrice ?? null,
      s?.pnlUsd ?? null,
      s?.tpLevel ?? null,
      s?.signalTime ?? null,
      input.rawText,
      input.forwardedText,
      input.reformatted ? 1 : 0,
      s ? JSON.stringify(s) : null,
    );
  return Number(info.lastInsertRowid);
}

export function updateSignalEventDestMessage(
  tenantId: number,
  sourceMessageId: string,
  destGroupId: string,
  destMessageId: string,
): void {
  getDb()
    .prepare(
      `UPDATE signal_events
       SET dest_message_id = ?
       WHERE tenant_id = ? AND source_message_id = ? AND dest_group_id = ?`,
    )
    .run(destMessageId, tenantId, sourceMessageId, destGroupId);
}

export function listSignalEvents(opts: {
  tenantId?: number;
  code?: string;
  kind?: string;
  orderKey?: string;
  limit?: number;
  offset?: number;
}): SignalEventRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.tenantId != null) {
    where.push('tenant_id = ?');
    params.push(opts.tenantId);
  }
  if (opts.code) {
    where.push('code = ?');
    params.push(opts.code.toUpperCase());
  }
  if (opts.kind) {
    where.push('kind = ?');
    params.push(opts.kind);
  }
  if (opts.orderKey) {
    where.push('order_key = ?');
    params.push(opts.orderKey);
  }
  const limit = opts.limit ?? 200;
  const offset = opts.offset ?? 0;
  const sql = `SELECT * FROM signal_events
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id ASC
    LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = getDb().prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

function mapRow(r: Record<string, unknown>): SignalEventRow {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    sourceGroupId: String(r.source_group_id),
    sourceMessageId: String(r.source_message_id),
    sourceTs: r.source_ts != null ? Number(r.source_ts) : null,
    destGroupId: String(r.dest_group_id),
    destMessageId: r.dest_message_id != null ? String(r.dest_message_id) : null,
    senderName: r.sender_name != null ? String(r.sender_name) : null,
    kind: String(r.kind) as SignalEventRow['kind'],
    code: r.code != null ? String(r.code) : null,
    ticket: r.ticket != null ? String(r.ticket) : null,
    side: r.side != null ? (String(r.side) as SignalSide) : null,
    product: r.product != null ? String(r.product) : null,
    orderKey: r.order_key != null ? String(r.order_key) : null,
    entryPrice: r.entry_price != null ? String(r.entry_price) : null,
    slPrice: r.sl_price != null ? String(r.sl_price) : null,
    tpPrice: r.tp_price != null ? String(r.tp_price) : null,
    hitPrice: r.hit_price != null ? String(r.hit_price) : null,
    pnlUsd: r.pnl_usd != null ? String(r.pnl_usd) : null,
    tpLevel: r.tp_level != null ? String(r.tp_level) : null,
    signalTime: r.signal_time != null ? String(r.signal_time) : null,
    rawText: String(r.raw_text),
    forwardedText: String(r.forwarded_text),
    reformatted: Number(r.reformatted) === 1,
    createdAt: String(r.created_at),
  };
}
