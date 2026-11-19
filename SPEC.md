# SPEC: Gộp Telegram Topic Bridge vào Zalo Message Forward

Nguồn tham chiếu: **tg-zalo** (`/Users/dinhtam94/0.work/tg-zalo`).

## Mục tiêu

Ngoài Zalo group → Zalo group, hỗ trợ **Zalo group / 1-1 → Telegram forum topic**.

**Mỗi tenant gắn 1 forum Telegram riêng** (`/tgbind`). Trong forum đó dùng lệnh kiểu tg-zalo.

## Mô hình cấu hình

| Cấp | Cái gì | Cách set |
|-----|--------|----------|
| Server | `TELEGRAM_BOT_TOKEN` (+ tuỳ chọn `TELEGRAM_ADMIN_IDS` global) | `.env` |
| Tenant | 1 `forum_group_id` + danh sách TG admin | Zalo bot: `/tgbind`, `/tgadmins` |
| Luật / topic | Zalo nguồn → 1 topic trong forum tenant | Zalo `/addtg` hoặc Telegram `/useradd` |

## Phạm vi

| Có | Không (ngoài parity forum) |
|----|----------------------------|
| Per-tenant forum | Multi-forum / tenant |
| Forward text/ảnh/link + selfListen | Channel broadcast + signature |
| message_links z2t/t2z + quote reply | CRM approve/block/mute theo topic |
| `/history` + auto-backfill `/useradd` group | Video/file/voice đầy đủ |
| `/del` + edit sync + Zalo undo map | Đăng ký 1-1 tự động |
| `/search` `/useredit` batch | |
| Reply topic → Zalo (twoway) | |
| `/inbox` — gom tin 1-1 chưa map vào 1 topic | |

## Lệnh Telegram (forum admin)

- `/help` `/config` `/users` `/search` `/useradd` `/useredit` `/userdel`
- `/tginfo` `/recreate` `/history` `/del`
- `/readonly` `/twoway` `/zalochats` `/zalogroups` `/zalofriends` `/id`
- Reply text/ảnh (twoway) · reply tin đã bridge → quote Zalo · sửa tin TG → sync Zalo

## Schema

- `tenant_telegram`, `telegram_topics` (+ `thread_kind`, `inbound_only`)
- `message_links` (tenant_id, zalo↔telegram ids, direction)
- `rule_targets.dest_group_id = tg:#<topicId>`

## Env

| Biến | Bắt buộc | Mô tả |
|------|----------|--------|
| `TELEGRAM_BOT_TOKEN` | Khi bật TG | BotFather |
| `TELEGRAM_ADMIN_IDS` | Không | Super-admin toàn cục |
