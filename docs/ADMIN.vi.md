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
3. `/addrule <nguồn> <đích,...> all` — xem `/help addrule`
4. `/rules` — xem; `/rules off 1` tắt; `/rules del 1` xóa
5. `/pause` / `/resume` — tạm dừng / bật lại

## Luật chuyển tiếp

- Một nguồn → nhiều đích  
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
| Chỉ thấy tin của mình | Cần restart sau bản có `selfListen`; kiểm tra log `Enqueued forward jobs` có `sender` khác nhau |
| Gần bị limit | Tăng `ZALO_MIN_SEND_INTERVAL_MS`, giảm `ZALO_SEND_MAX_PER_MINUTE` |

## Rủi ro

Automation Zalo cá nhân **không chính thức**. Khuyến nghị nick phụ, rate limit chặt, không spam.
