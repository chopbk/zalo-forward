import { getDb } from './client.js';

/** Returns true if newly claimed (first time). False if already processed. */
export function claimProcessedMessage(tenantId: number, messageId: string): boolean {
  try {
    const info = getDb()
      .prepare(
        `INSERT INTO processed_messages (tenant_id, message_id) VALUES (?, ?)`,
      )
      .run(tenantId, messageId);
    return info.changes > 0;
  } catch {
    return false;
  }
}
