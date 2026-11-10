import { ThreadType, type API, type ZaloListenerMessage } from 'zca-js';
import { getEnv } from '../config/env.js';
import logger from '../config/logger.js';
import { SendQueue } from '../relay/queue.js';
import {
  parseGroupMessage,
  type NormalizedGroupMessage,
} from '../relay/normalize.js';
import { downloadZaloMedia, safeUnlink, writeTempImage } from './media.js';

export type GroupInboundHandler = (
  msg: NormalizedGroupMessage,
) => void | Promise<void>;

export class PersonalAccountAdapter {
  private handler: GroupInboundHandler | null = null;
  private readonly queue: SendQueue;
  private started = false;

  constructor(
    readonly tenantId: number,
    private readonly api: API,
    private readonly sessionPath: string,
  ) {
    const env = getEnv();
    this.queue = new SendQueue(env.ZALO_MIN_SEND_INTERVAL_MS, env.ZALO_SEND_MAX_PER_MINUTE);
  }

  getOwnId(): string {
    return this.api.getOwnId();
  }

  onGroupMessage(handler: GroupInboundHandler): void {
    this.handler = handler;
  }

  start(): void {
    if (this.started) return;
    this.api.listener.on('message', (message) => {
      void this.handleMessage(message).catch((err) => {
        logger.error({ err, tenantId: this.tenantId }, 'Personal inbound failed');
      });
    });
    this.api.listener.start();
    this.started = true;
    logger.info({ tenantId: this.tenantId }, 'Personal listener started');
  }

  stop(): void {
    if (!this.started) return;
    try {
      this.api.listener.stop();
    } catch {
      // ignore
    }
    this.handler = null;
    this.started = false;
  }

  private async handleMessage(message: ZaloListenerMessage): Promise<void> {
    if (message.type !== ThreadType.Group) return;
    if (message.isSelf) return;
    if (!this.handler) return;

    const normalized = parseGroupMessage(message);
    if (!normalized) return;
    await this.handler(normalized);
  }

  async listGroups(): Promise<Array<{ groupId: string; name: string }>> {
    const all = await this.api.getAllGroups();
    const ids = Object.keys(all.gridVerMap ?? {});
    if (ids.length === 0) return [];
    const info = await this.api.getGroupInfo(ids);
    const map = info.gridInfoMap ?? {};
    return ids.map((id) => ({
      groupId: id,
      name: map[id]?.name ?? id,
    }));
  }

  sendText(groupId: string, text: string): Promise<{ messageId: string }> {
    return this.queue.enqueue(async () => {
      const result = await this.api.sendMessage(text, groupId, ThreadType.Group);
      return {
        messageId: String(result.message?.msgId ?? 'ok'),
      };
    });
  }

  sendImages(
    groupId: string,
    images: Array<{ url: string }>,
    caption = '',
  ): Promise<{ messageId: string }> {
    return this.queue.enqueue(async () => {
      const paths: string[] = [];
      try {
        for (const img of images) {
          const buf = await downloadZaloMedia(img.url, this.sessionPath);
          const path = await writeTempImage(buf);
          paths.push(path);
        }
        const result = await this.api.sendMessage(
          {
            msg: caption,
            attachments: paths.length === 1 ? paths[0]! : paths,
          },
          groupId,
          ThreadType.Group,
        );
        return {
          messageId: String(
            result.message?.msgId ?? result.attachment?.[0]?.msgId ?? 'ok',
          ),
        };
      } finally {
        await Promise.all(paths.map((p) => safeUnlink(p)));
      }
    });
  }
}
