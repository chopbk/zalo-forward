# SPEC: Gộp Telegram Topic Bridge vào Zalo Message Forward

Nguồn tham chiếu: **tg-zalo** (`/Users/dinhtam94/0.work/tg-zalo`).

## Mục tiêu

Ngoài Zalo group → Zalo group, hỗ trợ **Zalo group → Telegram forum topic**.

**Mỗi tenant gắn 1 forum Telegram riêng** (`/tgbind`). Trong forum đó dùng lệnh kiểu tg-zalo (`/useradd`, `/users`, `/readonly`…).

## Mô hình cấu hình

| Cấp | Cái gì | Cách set |
|-----|--------|----------|
| Server | `TELEGRAM_BOT_TOKEN` (+ tuỳ chọn `TELEGRAM_ADMIN_IDS` global) | `.env` |
| Tenant | 1 `forum_group_id` + danh sách TG admin | Zalo bot: `/tgbind`, `/tgadmins` |
| Luật / topic | Zalo group nguồn → 1 topic trong forum tenant | Zalo `/addtg` hoặc Telegram `/useradd` |

Không còn 1 `TELEGRAM_FORUM_GROUP_ID` dùng chung mọi user.

## Luồng setup (tenant)

```
1. Admin server: TELEGRAM_BOT_TOKEN=...
2. Tenant tạo/supergroup, bật Topics, add bot admin (Manage topics)
3. Trong forum: /id → copy chat.id (-100…)
4. Zalo bot: /tgbind -100…
5. Zalo bot: /tgadmins <telegram_user_id,...>
6. /login (Zalo session) → /addtg <group_id> all
   hoặc trong forum: /useradd <group_id>
```

## Phạm vi MVP

| Có | Không |
|----|--------|
| Per-tenant forum | Multi-forum / tenant |
| Tạo topic + forward text/ảnh/link | Channel broadcast (luồng C tg-zalo) |
| Reply topic → Zalo (twoway) | Đăng ký khách 1-1 |
| Lệnh TG: help, config, users, useradd, userdel, tginfo, recreate, readonly/twoway, zalochats, id | Full CRUD useredit / mute / broadcast |
| Filter all/keywords như luật Zalo | Video/file/voice |

## Lệnh

### Zalo Bot (control plane)

- `/tgbind <forum_id>` / `/tgunbind` / `/tgadmins <ids>` / `/tgstatus`
- `/addtg <nguồn> [all\|keywords …] [readonly]`
- `/addrule <nguồn> tg[,zalo…] all`

### Telegram (trong forum đã bind, user ∈ tgadmins ∪ TELEGRAM_ADMIN_IDS)

- `/help` `/config` `/users` `/useradd` `/userdel` `/tginfo` `/recreate`
- `/readonly` `/twoway` `/zalochats` `/id`
- Reply text/ảnh trong topic → Zalo group (nếu không readonly)

## Schema

- `tenant_telegram(tenant_id, forum_group_id UNIQUE, admin_ids, enabled)`
- `telegram_topics(…, telegram_chat_id = forum của tenant)`
- `rule_targets.dest_group_id = tg:#<topicId>`

## Env

| Biến | Bắt buộc | Mô tả |
|------|----------|--------|
| `TELEGRAM_BOT_TOKEN` | Khi bật TG | BotFather |
| `TELEGRAM_ADMIN_IDS` | Không | Super-admin toàn cục |
| `TELEGRAM_FORUM_GROUP_ID` | Không | Deprecated |

## Nghiệm thu

- [ ] Thiếu token → không start grammY; có token → start
- [ ] Tenant A/B `/tgbind` 2 forum khác nhau; topic không lẫn
- [ ] Forum đã bind bởi A → B `/tgbind` cùng id bị từ chối
- [ ] `/useradd` trong forum A tạo topic + forward đúng session tenant A
- [ ] Admin không nằm trong tgadmins/global → không điều khiển / không reply→Zalo
- [ ] `npm test` (unit không DB) + `npm run typecheck` pass
