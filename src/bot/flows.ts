import {
  clearConversation,
  getConversation,
  setConversation,
  type Conversation,
} from '../db/conversations.js';
import type { Tenant } from '../db/tenants.js';
import type { ZaloBotControl } from './adapter.js';

/**
 * Conversation flows còn lại (nếu có). /addrule và /keywords đã là lệnh 1 dòng.
 * Giữ /cancel clear state cũ nếu user còn kẹt wizard phiên bản trước.
 */
export async function handleConversationReply(
  bot: ZaloBotControl,
  tenant: Tenant,
  text: string,
  conv: Conversation,
): Promise<boolean> {
  const raw = text.trim();
  if (raw === '/cancel' || raw.toLowerCase() === 'hủy' || raw.toLowerCase() === 'huy') {
    clearConversation(tenant.zaloBotUserId);
    await bot.sendText(tenant.zaloBotUserId, 'Đã hủy. Gõ /help để xem lệnh.');
    return true;
  }

  if (conv.state !== 'idle') {
    clearConversation(tenant.zaloBotUserId);
    await bot.sendText(
      tenant.zaloBotUserId,
      'Wizard cũ đã tắt. Dùng lệnh 1 dòng:\n' +
        '/addrule <nguồn> <đích,...> all\n' +
        '/addrule <nguồn> <đích,...> keywords <kw,...>\n' +
        '/help addrule',
    );
    return true;
  }

  return false;
}

export { getConversation, clearConversation, setConversation };
