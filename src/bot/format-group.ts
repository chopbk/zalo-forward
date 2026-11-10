import { getGroupName } from '../db/rules.js';

/** Hiển thị "Tên (id)" — thiếu tên thì chỉ id. */
export function formatGroupLabel(tenantId: number, groupId: string): string {
  const name = getGroupName(tenantId, groupId)?.trim();
  if (!name || name === groupId) return groupId;
  return `${name} (${groupId})`;
}

export function formatGroupList(tenantId: number, groupIds: string[]): string {
  return groupIds.map((id) => formatGroupLabel(tenantId, id)).join(', ');
}
