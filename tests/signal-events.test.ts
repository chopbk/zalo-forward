import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/db/client.js';
import {
  insertSignalEvent,
  listSignalEvents,
  updateSignalEventDestMessage,
} from '../src/db/signal-events.js';
import { parseSignalMeta } from '../src/relay/signal-meta.js';

describe('signal_events storage', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zmf-sig-'));
    process.env.DATABASE_PATH = join(dir, 'test.db');
    process.env.SESSION_DIR = join(dir, 'sessions');
    closeDb();
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores and lists tp events for backtest', () => {
    const raw = `✅✅✅ Bạch kim tháng 1 (PLEF27) [1] đạt TP3 tại 1406.85 (giá vào 1468.11).
Lãi: +3,063.00 USD/Lot
Lúc 09:06:05`;
    const signal = parseSignalMeta(raw);
    expect(signal?.kind).toBe('tp');

    insertSignalEvent({
      tenantId: 3,
      sourceGroupId: 'src',
      sourceMessageId: 'm1',
      sourceTs: 1_700_000_000_000,
      destGroupId: 'dest',
      senderName: 'Hct Edu',
      rawText: raw,
      forwardedText: 'forwarded',
      reformatted: true,
      signal,
    });

    updateSignalEventDestMessage(3, 'm1', 'dest', 'dest-msg-9');

    const rows = listSignalEvents({ tenantId: 3, code: 'PLEF27' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'tp',
      code: 'PLEF27',
      ticket: '1',
      orderKey: 'PLEF27#1',
      hitPrice: '1406.85',
      entryPrice: '1468.11',
      pnlUsd: '+3,063.00',
      destMessageId: 'dest-msg-9',
      reformatted: true,
    });
  });
});
