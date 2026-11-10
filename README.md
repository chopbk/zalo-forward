# Zalo Message Forward

Chuyển tiếp tin nhắn / ảnh / link từ **group Zalo nguồn** sang **nhiều group đích**, cấu hình qua **Zalo Bot Platform**. Multi-tenant: nhiều user dùng chung bot; chỉ hoạt động sau khi **admin duyệt**.

> **Cảnh báo:** Data plane dùng [zca-js](https://github.com/RFS-ADRENO/zca-js) (unofficial). Nick có thể bị hạn chế/ban. Nên dùng **nick Zalo phụ**. Bạn chịu trách nhiệm tuân thủ điều khoản Zalo và pháp luật.

## Kiến trúc ngắn

| Lớp | Vai trò |
|-----|---------|
| Zalo Bot Platform | Đăng ký, duyệt, QR login, cấu hình luật |
| zca-js (personal) | Nghe group + gửi sang group đích (mỗi user 1 session) |
| SQLite | Tenant, rules, jobs, dedup |

## Quick start

```bash
cp .env.example .env
# Điền ZALO_BOT_TOKEN + ADMIN_SETUP_PASSWORD
npm install
npm run dev
```

1. Bạn chat bot: `/iamadmin <mật_khẩu>` → thành admin (id tự lưu DB)  
2. User khác: `/start` → chờ duyệt  
3. Admin: `/pending` → `/approve <id>`  
4. User: `/login` (quét QR) → `/groups` → `/addrule`  

- Hướng dẫn lệnh (user + admin): [docs/HUONG-DAN-SU-DUNG.md](./docs/HUONG-DAN-SU-DUNG.md)  
- Vận hành server / admin: [docs/ADMIN.vi.md](./docs/ADMIN.vi.md)

## Env

Xem [`.env.example`](./.env.example). Bắt buộc:

- `ZALO_BOT_TOKEN` — token Bot Platform  
- `ADMIN_SETUP_PASSWORD` — mật khẩu claim admin qua `/iamadmin` (khuyên dùng)

Tuỳ chọn: `ADMIN_ZALO_USER_IDS` nếu đã biết sẵn id.

QR login trên **VPS**: Zalo cần URL **HTTPS**. Khuyên dùng `PUBLIC_BASE_URL=https://domain` (nginx + SSL) hoặc `IMGBB_API_KEY`. Không dùng `http://IP`. Fallback: telegra/catbox (`QR_TEMP_UPLOAD=true`).

## Scripts

| Script | Mô tả |
|--------|--------|
| `npm run dev` | Dev + watch |
| `npm run build` / `start` | Production |
| `npm test` | Vitest |
| `npm run typecheck` | `tsc --noEmit` |

## License

MIT
