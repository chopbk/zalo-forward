import express from 'express';
import { mkdirSync } from 'node:fs';
import { getEnv } from './config/env.js';
import logger from './config/logger.js';
import { getDb } from './db/client.js';
import { ZaloBotControl } from './bot/adapter.js';
import { wireBotCommands } from './bot/commands.js';
import { sessionManager } from './personal/manager.js';
import {
  handleGroupInbound,
  startJobWorker,
  stopJobWorker,
} from './relay/engine.js';

async function main(): Promise<void> {
  const env = getEnv();
  mkdirSync(env.SESSION_DIR, { recursive: true });
  mkdirSync(env.QR_DIR, { recursive: true });

  getDb();
  logger.info({ db: env.DATABASE_PATH }, 'Database ready');

  const bot = new ZaloBotControl();
  wireBotCommands(bot);

  sessionManager.onInbound(async (tenant, msg) => {
    await handleGroupInbound(tenant, msg);
  });

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'zalo-message-forward' });
  });

  bot.mountQrStatic(app);
  if (env.zaloBotTransport === 'webhook') {
    bot.mountWebhook(app);
  }

  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'HTTP server listening');
  });

  await bot.start();
  await sessionManager.startAllReady();
  startJobWorker(500);

  logger.info('Zalo Message Forward is running');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopJobWorker();
    await sessionManager.stopAll();
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
