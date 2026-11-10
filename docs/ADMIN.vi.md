# Hướng dẫn admin — Zalo Message Forward

## Chuẩn bị

1. Tạo bot trên **Zalo Bot Platform** (OA Zalo Bot Manager) → lấy `ZALO_BOT_TOKEN`.
2. Chat với bot một lần, lấy **user id** của bạn → ghi vào `ADMIN_ZALO_USER_IDS`.
3. `cp .env.example .env` → điền token + admin ids → `npm install` → `npm run dev`.
4. (Khuyến nghị) public HTTPS + `PUBLIC_BASE_URL` để gửi link QR.

## Duyệt user

Khi user gõ `/start`, admin nhận thông báo.

| Lệnh | Việc |
|------|------|
| `/pending` | Danh sách chờ |
| `/approve <id>` | Duyệt |
| `/reject <id>` | Từ chối |
| `/users` | Tất cả tenant |
| `/suspend <id>` / `/unsuspend <id>` | Khóa / mở |
| `/tenant <id>` | Chi tiết |
| `/adminhelp` | Trợ giúp admin |

## User làm gì sau khi duyệt

1. `/login` — quét QR nick **phụ** (không mở Zalo Web song song)
2. `/groups` — copy id group
3. `/addrule` — wizard: nguồn → đích → tất cả / từ khóa
4. `/rules` — xem; `/rules off 1` tắt; `/rules del 1` xóa
5. `/pause` / `/resume` — tạm dừng / bật lại

## Luật chuyển tiếp

- Một nguồn → nhiều đích  
- Lọc **all** hoặc **keywords** (substring, không phân biệt hoa thường)  
- Bỏ qua tin do chính nick gửi (`isSelf`) để giảm loop  
- Nếu tạo A→B và B→A, bot cảnh báo vòng lặp  

## Sự cố thường gặp

| Hiện tượng | Cách xử lý |
|------------|------------|
| QR không hiện ảnh | Set `PUBLIC_BASE_URL` hoặc mở file PNG trong `QR_DIR` |
| Listener dừng | Không mở Zalo Web cùng nick; `/logout` rồi `/login` |
| Không forward | `/status` — approved? session active? relay on? có rule đúng nguồn? |
| Gần bị limit | Tăng `ZALO_MIN_SEND_INTERVAL_MS`, giảm `ZALO_SEND_MAX_PER_MINUTE` |

## Rủi ro

Automation Zalo cá nhân **không chính thức**. Khuyến nghị nick phụ, rate limit chặt, không spam.
