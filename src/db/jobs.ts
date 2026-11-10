import { getDb, type JobStatus } from './client.js';
import { getEnv } from '../config/env.js';

export type ForwardJobPayload = {
  sourceGroupId: string;
  destGroupId: string;
  text?: string;
  images?: Array<{ url: string }>;
  sourceMessageId: string;
  senderName?: string;
};

export type ForwardJob = {
  id: number;
  tenantId: number;
  type: string;
  status: JobStatus;
  payload: ForwardJobPayload;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextRunAt: string;
};

function mapJob(row: {
  id: number;
  tenant_id: number;
  type: string;
  status: JobStatus;
  payload: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  next_run_at: string;
}): ForwardJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    status: row.status,
    payload: JSON.parse(row.payload) as ForwardJobPayload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    nextRunAt: row.next_run_at,
  };
}

export function enqueueForwardJobs(
  tenantId: number,
  items: ForwardJobPayload[],
): number[] {
  const maxAttempts = getEnv().JOB_MAX_RETRIES;
  const stmt = getDb().prepare(
    `INSERT INTO forward_jobs (tenant_id, type, status, payload, max_attempts)
     VALUES (?, 'forward_item', 'pending', ?, ?)`,
  );
  const ids: number[] = [];
  const tx = getDb().transaction(() => {
    for (const item of items) {
      const info = stmt.run(tenantId, JSON.stringify(item), maxAttempts);
      ids.push(Number(info.lastInsertRowid));
    }
  });
  tx();
  return ids;
}

export function claimNextJob(tenantId?: number): ForwardJob | null {
  const db = getDb();
  const row = (
    tenantId != null
      ? db
          .prepare(
            `SELECT * FROM forward_jobs
             WHERE status = 'pending' AND tenant_id = ? AND next_run_at <= datetime('now')
             ORDER BY id ASC LIMIT 1`,
          )
          .get(tenantId)
      : db
          .prepare(
            `SELECT * FROM forward_jobs
             WHERE status = 'pending' AND next_run_at <= datetime('now')
             ORDER BY id ASC LIMIT 1`,
          )
          .get()
  ) as
    | {
        id: number;
        tenant_id: number;
        type: string;
        status: JobStatus;
        payload: string;
        attempts: number;
        max_attempts: number;
        last_error: string | null;
        next_run_at: string;
      }
    | undefined;

  if (!row) return null;

  const info = db
    .prepare(
      `UPDATE forward_jobs SET status = 'running', attempts = attempts + 1,
         updated_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
    )
    .run(row.id);
  if (info.changes === 0) return null;

  return mapJob({ ...row, status: 'running', attempts: row.attempts + 1 });
}

export function markJobDone(id: number): void {
  getDb()
    .prepare(
      `UPDATE forward_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?`,
    )
    .run(id);
}

export function markJobFailedOrRetry(id: number, error: string): void {
  const row = getDb()
    .prepare(`SELECT attempts, max_attempts FROM forward_jobs WHERE id = ?`)
    .get(id) as { attempts: number; max_attempts: number } | undefined;
  if (!row) return;

  if (row.attempts >= row.max_attempts) {
    getDb()
      .prepare(
        `UPDATE forward_jobs SET status = 'failed', last_error = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(error.slice(0, 500), id);
    return;
  }

  const backoffSec = Math.min(300, 5 * 2 ** (row.attempts - 1));
  getDb()
    .prepare(
      `UPDATE forward_jobs SET status = 'pending', last_error = ?,
         next_run_at = datetime('now', ?),
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(error.slice(0, 500), `+${backoffSec} seconds`, id);
}

export function countPendingJobs(tenantId?: number): number {
  if (tenantId != null) {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM forward_jobs WHERE tenant_id = ? AND status IN ('pending','running')`,
      )
      .get(tenantId) as { c: number };
    return row.c;
  }
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM forward_jobs WHERE status IN ('pending','running')`,
    )
    .get() as { c: number };
  return row.c;
}
