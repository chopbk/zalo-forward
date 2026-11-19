# Hướng dẫn admin — Zalo Message Forward

## Chuẩn bị

1. Tạo bot trên **Zalo Bot Platform** (OA Zalo Bot Manager) → lấy `ZALO_BOT_TOKEN`.
2. `cp .env.example .env` → điền token + **`ADMIN_SETUP_PASSWORD`** (mật khẩu tự chọn).
3. `npm install` → `npm run dev`.
4. Chat với bot:
   - `/whoami` — xem Zalo user id của bạn (không bắt buộc)
   - `/iamadmin <mật_khẩu>` — nhận quyền admin, **id tự lưu vào DB**
5. QR trên VPS (chọn 1):
   - `PUBLIC_BASE_URL=https://qr.domain.com` + nginx SSL proxy `/qr/` → app
   - hoặc `IMGBB_API_KEY=...` (tạo key miễn phí tại imgbb)
   - Không dùng `http://IP` — Zalo Bot từ chối

Không cần biết trước user id. `ADMIN_ZALO_USER_IDS` chỉ là tuỳ chọn seed.

## Duyệt user

Khi user gõ `/start`, admin nhận thông báo.

| Lệnh | Việc |
|------|------|
| `/iamadmin <mk>` | Claim admin lần đầu (ai biết mật khẩu) |
| `/whoami` | Xem id của mình |
| `/pending` | Danh sách chờ |
| `/approve <id>` | Duyệt |
| `/reject <id>` | Từ chối |
| `/users` | Tất cả tenant |
| `/suspend <id>` / `/unsuspend <id>` | Khóa / mở |
| `/tenant <id>` | Chi tiết |
| `/admins` | Admin đã lưu DB |
| `/revokeadmin <zalo_user_id>` | Gỡ admin DB |
| `/adminhelp` | Trợ giúp admin |

## User làm gì sau khi duyệt

1. `/login` — quét QR nick **phụ** (không mở Zalo Web song song)
2. `/groups` — copy id group
3. `/addrule <nguồn> <đích,...> all` — Zalo→Zalo (xem `/help addrule`)
4. `/addtg <nguồn> all` — Zalo→Telegram topic (nếu server bật TG)
5. `/rules` — xem; `/rules off 1` tắt; `/rules del 1` xóa
6. `/pause` / `/resume` — tạm dừng / bật lại

## Telegram topic bridge (1 tenant = 1 forum)

1. Server: `TELEGRAM_BOT_TOKEN` (+ tuỳ chọn `TELEGRAM_ADMIN_IDS` super-admin)
2. **Mỗi tenant** tạo forum riêng (Topics), add bot admin Manage topics
3. Trong forum gửi `/id` → copy `chat.id`
4. Zalo bot: `/tgbind -100…` rồi `/tgadmins <telegram_user_id,...>`
5. `/addtg <zalo_group_id> all` **hoặc** trong forum: `/useradd <zalo_group_id>`
6. Reply trong topic (user ∈ tgadmins tenant hoặc TELEGRAM_ADMIN_IDS) → Zalo

Tắt bridge toàn cục: xóa `TELEGRAM_BOT_TOKEN`. Gỡ 1 tenant: `/tgunbind`.

## Luật chuyển tiếp

- Một nguồn → nhiều đích (Zalo group và/hoặc `tg:#topic`)  
- Lọc **all** = mọi tin text/ảnh/link trong **group nguồn** (mọi thành viên, kể cả nick đã `/login`)  
- Lọc **keywords** = substring, không phân biệt hoa thường  
- Tin do bot vừa gửi sang group đích bị lọc echo để giảm vòng lặp  
- Nếu tạo A→B và B→A, bot cảnh báo vòng lặp — tránh  

## Sự cố thường gặp

| Hiện tượng | Cách xử lý |
|------------|------------|
| QR không vào chat (VPS) | Set `PUBLIC_BASE_URL=https://...` hoặc `IMGBB_API_KEY`. Xem log `temp host failed` / `sendPhoto`. Không dùng IP HTTP |
| Listener dừng | Không mở Zalo Web cùng nick; `/logout` rồi `/login` |
| Không forward | `/status` — approved? session active? relay on? `/addrule` đúng **id group** từ `/groups` (không phải chat 1-1 với bot Official)? |
| Không tạo topic | `/tgstatus`; bot Telegram admin + Topics; đủ `TELEGRAM_*` |
| Reply topic không vào Zalo | User Telegram có trong `TELEGRAM_ADMIN_IDS`? Topic không `readonly`? Session tenant `active`? |
| Chỉ thấy tin của mình | Cần restart sau bản có `selfListen`; kiểm tra log `Enqueued forward jobs` có `sender` khác nhau |
| Gần bị limit | Tăng `ZALO_MIN_SEND_INTERVAL_MS`, giảm `ZALO_SEND_MAX_PER_MINUTE` |

## Rủi ro

Automation Zalo cá nhân **không chính thức**. Khuyến nghị nick phụ, rate limit chặt, không spam.
