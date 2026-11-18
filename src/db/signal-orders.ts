import { getDb } from './client.js';

/** Meta đủ để truyền vào sendMessage.quote */
export type StoredSignalQuote = {
  content: string;
  msgType: string;
  propertyExt: {
    color: number;
    size: number;
    type: number;
    subType: number;
    ext: string;
  };
  uidFrom: string;
  msgId: string;
  cliMsgId: string;
  ts: string;
  ttl: number;
};

export type UpsertSignalOrderInput = {
  tenantId: number;
  destGroupId: string;
  orderKey: string;
  kind: 'pending' | 'filled';
  msgId: string;
  cliMsgId: string;
  uidFrom: string;
  content: string;
  msgType?: string;
  ts: string;
  ttl?: number;
};

const DEFAULT_PROPERTY_EXT = {
  color: 0,
  size: 0,
  type: 0,
  subType: 0,
  ext: '{"shouldParseLinkOrContact":0}',
};

export function upsertSignalOrder(input: UpsertSignalOrderInput): void {
  getDb()
    .prepare(
      `INSERT INTO signal_order_msgs (
         tenant_id, dest_group_id, order_key, kind,
         msg_id, cli_msg_id, uid_from, content, msg_type, ts, ttl, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(tenant_id, dest_group_id, order_key) DO UPDATE SET
         kind = excluded.kind,
         msg_id = excluded.msg_id,
         cli_msg_id = excluded.cli_msg_id,
         uid_from = excluded.uid_from,
         content = excluded.content,
         msg_type = excluded.msg_type,
         ts = excluded.ts,
         ttl = excluded.ttl,
         updated_at = datetime('now')`,
    )
    .run(
      input.tenantId,
      input.destGroupId,
      input.orderKey,
      input.kind,
      input.msgId,
      input.cliMsgId,
      input.uidFrom,
      input.content.slice(0, 500),
      input.msgType ?? 'webchat',
      input.ts,
      input.ttl ?? 0,
    );
}

/** Đồng bộ cliMsgId từ echo isSelf (zca-js không trả cliMsgId khi send). */
export function patchSignalOrderCliMsgId(
  tenantId: number,
  destGroupId: string,
  msgId: string,
  cliMsgId: string,
): boolean {
  if (!cliMsgId) return false;
  const info = getDb()
    .prepare(
      `UPDATE signal_order_msgs
       SET cli_msg_id = ?, updated_at = datetime('now')
       WHERE tenant_id = ? AND dest_group_id = ? AND msg_id = ?`,
    )
    .run(cliMsgId, tenantId, destGroupId, msgId);
  return info.changes > 0;
}

export function findSignalOrderQuote(
  tenantId: number,
  destGroupId: string,
  orderKey: string,
): StoredSignalQuote | null {
  const row = getDb()
    .prepare(
      `SELECT msg_id, cli_msg_id, uid_from, content, msg_type, ts, ttl
       FROM signal_order_msgs
       WHERE tenant_id = ? AND dest_group_id = ? AND order_key = ?`,
    )
    .get(tenantId, destGroupId, orderKey) as
    | {
        msg_id: string;
        cli_msg_id: string;
        uid_from: string;
        content: string;
        msg_type: string;
        ts: string;
        ttl: number;
      }
    | undefined;

  if (!row?.msg_id || !row.cli_msg_id) return null;

  return {
    content: row.content,
    msgType: row.msg_type || 'webchat',
    propertyExt: DEFAULT_PROPERTY_EXT,
    uidFrom: row.uid_from,
    msgId: row.msg_id,
    cliMsgId: row.cli_msg_id,
    ts: row.ts,
    ttl: row.ttl ?? 0,
  };
}

export function resolveSignalQuote(
  tenantId: number,
  destGroupId: string,
  prefer: Array<'filled' | 'pending'>,
  keys: { pendingKey: string; filledKey?: string },
): StoredSignalQuote | null {
  for (const kind of prefer) {
    const orderKey =
      kind === 'filled' ? keys.filledKey : keys.pendingKey;
    if (!orderKey) continue;
    const q = findSignalOrderQuote(tenantId, destGroupId, orderKey);
    if (q) return q;
  }
  return null;
}
