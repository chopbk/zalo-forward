import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache, verifyAdminSetupPassword } from '../src/config/env.js';
import { closeDb, getDb } from '../src/db/client.js';
import {
  addAdmin,
  isAdmin,
  listAdminNotifyIds,
  removeAdmin,
} from '../src/db/admins.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zmf-admin-'));
  process.env.ZALO_BOT_TOKEN = 'test-token';
  process.env.ADMIN_SETUP_PASSWORD = 'super-secret';
  process.env.ADMIN_ZALO_USER_IDS = 'seed-admin';
  process.env.DATABASE_PATH = join(dir, 'test.db');
  process.env.ZALO_BOT_TRANSPORT = 'polling';
  resetEnvCache();
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  resetEnvCache();
  rmSync(dir, { recursive: true, force: true });
});

describe('admin bootstrap', () => {
  it('verifies setup password', () => {
    expect(verifyAdminSetupPassword('super-secret')).toBe(true);
    expect(verifyAdminSetupPassword('wrong')).toBe(false);
  });

  it('env seed counts as admin', () => {
    expect(isAdmin('seed-admin')).toBe(true);
    expect(isAdmin('stranger')).toBe(false);
  });

  it('claims admin into DB', () => {
    const { created } = addAdmin('u-new', 'Boss');
    expect(created).toBe(true);
    expect(isAdmin('u-new')).toBe(true);
    expect(listAdminNotifyIds()).toEqual(expect.arrayContaining(['seed-admin', 'u-new']));
    expect(removeAdmin('u-new')).toBe(true);
    expect(isAdmin('u-new')).toBe(false);
  });
});
