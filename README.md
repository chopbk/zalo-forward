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
# Điền ZALO_BOT_TOKEN + ADMIN_ZALO_USER_IDS
npm install
npm run dev
```

1. User chat bot: `/start` → chờ duyệt  
2. Admin: `/pending` → `/approve <id>`  
3. User: `/login` (quét QR) → `/groups` → `/addrule`  
4. Tin ở group nguồn được forward theo luật  

Chi tiết vận hành: [docs/ADMIN.vi.md](./docs/ADMIN.vi.md)

## Env

Xem [`.env.example`](./.env.example). Bắt buộc:

- `ZALO_BOT_TOKEN` — token Bot Platform  
- `ADMIN_ZALO_USER_IDS` — id Zalo admin (người chat với bot)

Gợi ý: set `PUBLIC_BASE_URL` (HTTPS) để bot gửi link ảnh QR.

## Scripts

| Script | Mô tả |
|--------|--------|
| `npm run dev` | Dev + watch |
| `npm run build` / `start` | Production |
| `npm test` | Vitest |
| `npm run typecheck` | `tsc --noEmit` |

## License

MIT
