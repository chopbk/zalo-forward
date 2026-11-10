import { timingSafeEqual } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const baseSchema = z.object({
  ZALO_BOT_TOKEN: z.string().min(1),
  ZALO_BOT_TRANSPORT: z.enum(['polling', 'webhook']).optional(),
  ZALO_BOT_WEBHOOK_PATH: z.string().default('/webhooks/zalo-bot'),
  ZALO_BOT_WEBHOOK_SECRET: z.string().optional(),
  ZALO_BOT_POLL_TIMEOUT_SEC: z.coerce.number().int().positive().default(30),
  /** Optional seed admins (comma-separated). Prefer /iamadmin + ADMIN_SETUP_PASSWORD. */
  ADMIN_ZALO_USER_IDS: z.string().optional().default(''),
  /** Password to claim admin via /iamadmin <password> (recommended). */
  ADMIN_SETUP_PASSWORD: z.string().optional().default(''),
  DATABASE_PATH: z.string().default('./data/app.db'),
  SESSION_DIR: z.string().default('./data/sessions'),
  QR_DIR: z.string().default('./data/qr'),
  ZALO_MIN_SEND_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1500),
  ZALO_SEND_MAX_PER_MINUTE: z.coerce.number().int().nonnegative().default(20),
  JOB_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  LIST_PAGE_SIZE: z.coerce.number().int().positive().default(20),
  PORT: z.coerce.number().int().positive().default(3080),
  LOG_LEVEL: z.string().default('info'),
  PUBLIC_BASE_URL: z.string().optional(),
  /**
   * Upload QR lên host tạm để gửi ảnh qua bot. Mặc định tắt (host ngoài thường chậm).
   * Cách mặc định: mở PNG trên máy chạy bot.
   */
  QR_TEMP_UPLOAD: z
    .string()
    .optional()
    .default('false')
    .transform((v) => !['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase())),
  NODE_ENV: z.string().optional(),
});

export type Env = z.infer<typeof baseSchema> & {
  adminZaloUserIds: string[];
  zaloBotTransport: 'polling' | 'webhook';
};

let cached: Env | null = null;

/** Parse danh sách id: `1,2, 3` hoặc xuống dòng / `;` */
export function parseIdList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;\s]+/)) {
    const s = part.trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = baseSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid env: ${msg}`);
  }

  const data = parsed.data;
  const adminZaloUserIds = parseIdList(data.ADMIN_ZALO_USER_IDS ?? '');
  const setupPassword = (data.ADMIN_SETUP_PASSWORD ?? '').trim();

  if (adminZaloUserIds.length === 0 && !setupPassword) {
    throw new Error(
      'Cần ít nhất ADMIN_SETUP_PASSWORD (khuyên dùng) hoặc ADMIN_ZALO_USER_IDS',
    );
  }

  const zaloBotTransport =
    data.ZALO_BOT_TRANSPORT ??
    (process.env.NODE_ENV === 'production' ? 'webhook' : 'polling');

  if (zaloBotTransport === 'webhook' && !data.ZALO_BOT_WEBHOOK_SECRET) {
    throw new Error('Webhook transport requires ZALO_BOT_WEBHOOK_SECRET');
  }

  cached = { ...data, adminZaloUserIds, zaloBotTransport };
  return cached;
}

/** Test helper */
export function resetEnvCache(): void {
  cached = null;
}

export function verifyAdminSetupPassword(input: string): boolean {
  const expected = (getEnv().ADMIN_SETUP_PASSWORD ?? '').trim();
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  const max = Math.max(a.length, b.length, 1);
  const aa = Buffer.alloc(max);
  const bb = Buffer.alloc(max);
  a.copy(aa);
  b.copy(bb);
  return timingSafeEqual(aa, bb) && a.length === b.length;
}
