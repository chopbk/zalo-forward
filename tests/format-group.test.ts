import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb } from '../src/db/client.js';
import { upsertGroupCache } from '../src/db/rules.js';
import { createOrGetPending, setTenantStatus } from '../src/db/tenants.js';
import { formatGroupLabel, formatGroupList } from '../src/bot/format-group.js';

describe('formatGroupLabel', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zmf-fmt-'));
    process.env.DATABASE_PATH = path.join(dir, 't.db');
    closeDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows name and id when cached', () => {
    const { tenant } = createOrGetPending('u1');
    setTenantStatus(tenant.id, 'approved');
    upsertGroupCache(tenant.id, '9045111', 'Nhóm Sale');
    expect(formatGroupLabel(tenant.id, '9045111')).toBe('Nhóm Sale (9045111)');
    expect(formatGroupList(tenant.id, ['9045111', '9045222'])).toBe(
      'Nhóm Sale (9045111), 9045222',
    );
  });

  it('falls back to id when name missing', () => {
    const { tenant } = createOrGetPending('u2');
    expect(formatGroupLabel(tenant.id, '999')).toBe('999');
  });
});
