import { getDb } from './client.js';

export type ConversationState =
  | 'idle'
  | 'addrule_source'
  | 'addrule_targets'
  | 'addrule_filter'
  | 'addrule_keywords'
  | 'addrule_confirm'
  | 'keywords_rule_id'
  | 'keywords_add'
  | 'rule_action';

export type Conversation = {
  zaloBotUserId: string;
  state: ConversationState;
  data: Record<string, unknown>;
  updatedAt: string;
};

export function getConversation(zaloBotUserId: string): Conversation {
  const row = getDb()
    .prepare('SELECT * FROM bot_conversations WHERE zalo_bot_user_id = ?')
    .get(zaloBotUserId) as
    | {
        zalo_bot_user_id: string;
        state: string;
        data: string;
        updated_at: string;
      }
    | undefined;

  if (!row) {
    return {
      zaloBotUserId,
      state: 'idle',
      data: {},
      updatedAt: new Date().toISOString(),
    };
  }

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    data = {};
  }

  return {
    zaloBotUserId: row.zalo_bot_user_id,
    state: row.state as ConversationState,
    data,
    updatedAt: row.updated_at,
  };
}

export function setConversation(
  zaloBotUserId: string,
  state: ConversationState,
  data: Record<string, unknown> = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO bot_conversations (zalo_bot_user_id, state, data, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(zalo_bot_user_id) DO UPDATE SET
         state = excluded.state,
         data = excluded.data,
         updated_at = datetime('now')`,
    )
    .run(zaloBotUserId, state, JSON.stringify(data));
}

export function clearConversation(zaloBotUserId: string): void {
  setConversation(zaloBotUserId, 'idle', {});
}
