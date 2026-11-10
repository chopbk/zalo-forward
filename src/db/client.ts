import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';

export type TenantStatus = 'pending' | 'approved' | 'rejected' | 'suspended';
export type SessionStatus = 'none' | 'qr_pending' | 'active' | 'expired' | 'error';
export type FilterMode = 'all' | 'keywords';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export type TenantRow = {
  id: number;
  zalo_bot_user_id: string;
  display_name: string | null;
  status: TenantStatus;
  relay_enabled: number;
  created_at: string;
  updated_at: string;
};

export type SessionRow = {
  tenant_id: number;
  session_path: string | null;
  zalo_own_id: string | null;
  status: SessionStatus;
  last_error: string | null;
  updated_at: string;
};

export type ForwardRuleRow = {
  id: number;
  tenant_id: number;
  source_group_id: string;
  filter_mode: FilterMode;
  enabled: number;
  include_updates: number;
  created_at: string;
  updated_at: string;
};

let db: Database.Database | null = null;

const SCHEMA_VERSION = 1;

export function getDb(): Database.Database {
  if (db) return db;
  const path = getEnv().DATABASE_PATH;
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const row = database
    .prepare(`SELECT value FROM schema_meta WHERE key = 'version'`)
    .get() as { value: string } | undefined;
  const version = row ? Number(row.value) : 0;

  if (version < 1) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        zalo_bot_user_id TEXT NOT NULL UNIQUE,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','approved','rejected','suspended')),
        relay_enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        session_path TEXT,
        zalo_own_id TEXT,
        status TEXT NOT NULL DEFAULT 'none'
          CHECK (status IN ('none','qr_pending','active','expired','error')),
        last_error TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS groups_cache (
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        name TEXT,
        last_seen_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, group_id)
      );

      CREATE TABLE IF NOT EXISTS forward_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        source_group_id TEXT NOT NULL,
        filter_mode TEXT NOT NULL DEFAULT 'all'
          CHECK (filter_mode IN ('all','keywords')),
        enabled INTEGER NOT NULL DEFAULT 1,
        include_updates INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_rules_tenant_source
        ON forward_rules(tenant_id, source_group_id, enabled);

      CREATE TABLE IF NOT EXISTS rule_targets (
        rule_id INTEGER NOT NULL REFERENCES forward_rules(id) ON DELETE CASCADE,
        dest_group_id TEXT NOT NULL,
        PRIMARY KEY (rule_id, dest_group_id)
      );

      CREATE TABLE IF NOT EXISTS rule_keywords (
        rule_id INTEGER NOT NULL REFERENCES forward_rules(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        PRIMARY KEY (rule_id, keyword)
      );

      CREATE TABLE IF NOT EXISTS processed_messages (
        tenant_id INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        processed_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tenant_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS forward_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'forward_item',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','running','done','failed')),
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status_next
        ON forward_jobs(status, next_run_at);

      CREATE TABLE IF NOT EXISTS bot_conversations (
        zalo_bot_user_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'idle',
        data TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    database
      .prepare(
        `INSERT INTO schema_meta(key, value) VALUES('version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(SCHEMA_VERSION));
    logger.info({ version: SCHEMA_VERSION }, 'DB migrated');
  }
}

/** Test helper — close and clear singleton */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
