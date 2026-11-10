import { join } from 'node:path';
import { loginWithSession } from '../src/personal/session.js';

async function main(): Promise<void> {
  const path = join('data/sessions/1.json');
  const api = await loginWithSession(path);
  const groupIds = ['5323022518674117258', '907869241002349004'];

  for (const groupId of groupIds) {
    console.log('\n=== group', groupId, '===');
    try {
      const hist = await api.getGroupChatHistory(groupId, 8);
      const arr = hist.groupMsgs ?? [];
      console.log('count', arr.length);
      for (const m of arr.slice(0, 8)) {
        const d = m.data ?? (m as { data?: unknown }).data;
        if (!d || typeof d !== 'object') continue;
        const row = d as Record<string, unknown>;
        const content = row.content;
        console.log(
          JSON.stringify(
            {
              msgId: row.msgId,
              msgType: row.msgType,
              contentType: typeof content,
              contentPreview:
                typeof content === 'string'
                  ? content.slice(0, 100)
                  : content,
              propertyExt: row.propertyExt,
              mentions: row.mentions,
            },
            null,
            2,
          ),
        );
        console.log('---');
      }
    } catch (err) {
      console.error('hist fail', groupId, err);
    }
  }

  try {
    api.listener.stop();
  } catch {
    // ignore
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
