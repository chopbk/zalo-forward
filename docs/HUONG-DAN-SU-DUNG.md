# Hướng dẫn sử dụng — Zalo Message Forward

Bot chuyển tiếp tin nhắn từ **group Zalo nguồn** sang **một hoặc nhiều group đích**. Bạn cấu hình bằng cách chat với bot trên Zalo (Zalo Bot Platform).

> **Lưu ý:** Nick Zalo dùng để `/login` (data plane) là automation không chính thức — nên dùng **nick phụ**, không mở Zalo Web cùng lúc với listener.

---

## Luồng nhanh (lần đầu)

```
/start          → đăng ký, chờ admin duyệt
/login          → quét QR nick Zalo (phụ)
/groups         → lấy id group
/addrule ...    → tạo luật chuyển tiếp
/rules          → kiểm tra luật
```

Sau đó tin trong group nguồn (đúng luật) sẽ được chuyển sang group đích.

---

## Lệnh cho mọi người

| Lệnh | Mô tả |
|------|--------|
| `/whoami` hoặc `/myid` | Xem Zalo user id của bạn với bot |
| `/iamadmin <mật_khẩu>` | Claim quyền admin (mật khẩu = `ADMIN_SETUP_PASSWORD` trên server) |
| `/help` | Trợ giúp ngắn |
| `/help addrule` | Chi tiết lệnh tạo luật |
| `/cancel` | Thoát trạng thái hội thoại cũ (nếu còn) |

---

## Lệnh người dùng (sau khi được duyệt)

### Đăng ký & trạng thái

| Lệnh | Mô tả |
|------|--------|
| `/start` | Đăng ký dùng bot (trạng thái *pending* → chờ admin `/approve`) |
| `/status` | Xem trạng thái: duyệt chưa, session, relay on/off, số luật… |

### Đăng nhập nick Zalo (bắt buộc để forward)

| Lệnh | Mô tả |
|------|--------|
| `/login` | Tạo QR → bot gửi ảnh/link QR vào chat → quét bằng Zalo trên điện thoại |
| `/logout` | Đăng xuất nick, dừng listener / chuyển tiếp |
| `/groups` | Liệt kê group của nick đã login (tên + **id**) — dùng id này cho `/addrule` |

**Tips `/login`:**

- Dùng nick phụ; không mở Zalo Web/PC cùng nick khi listener đang chạy.
- Nếu không thấy ảnh QR: mở **link** bot gửi kèm (host tạm).
- Quét xong đợi tin “Đăng nhập OK” rồi mới `/groups`.

### Tạo & sửa luật chuyển tiếp

#### `/addrule` — tạo mới hoặc cập nhật theo nguồn

```
/addrule <id_nguồn> <id_đích1,id_đích2,...> all
/addrule <id_nguồn> <id_đích1,id_đích2,...> keywords <từ_khóa1,từ_khóa2,...>
```

| Tham số | Ý nghĩa |
|---------|---------|
| `id_nguồn` | 1 group nguồn (copy từ `/groups`) |
| `id_đích` | Một hoặc nhiều group đích, cách nhau bằng dấu phẩy; **không** trùng nguồn |
| `all` | Forward mọi tin text / ảnh / link (mọi thành viên trong group nguồn) |
| `keywords` | Chỉ forward tin có chứa ít nhất 1 từ khóa (không phân biệt hoa thường) |

**Ví dụ:**

```
/addrule 9045123456789012345 9045987654321098765 all
/addrule 9045123456789012345 9045987654321098765,9045111222333444555 all
/addrule 9045123456789012345 9045987654321098765 keywords sale,hot
```

**Hành vi:**

- Cùng `id_nguồn` → **cập nhật** luật cũ (không tạo bản trùng).
- Muốn thêm đích C vào nguồn A đã có đích B: `/addrule A B,C all`
- Nhiều nguồn khác nhau → gọi `/addrule` nhiều lần (mỗi nguồn một luật).
- Tránh vòng A→B và B→A (bot sẽ cảnh báo).

#### `/rules` — xem / sửa / bật / tắt / xóa

| Lệnh | Mô tả |
|------|--------|
| `/rules` | Liệt kê luật (id, nguồn, đích, lọc, bật/tắt) |
| `/rules set <id> <đích,...> all` | Sửa đích + lọc theo **id luật** |
| `/rules set <id> <đích,...> keywords <kw,...>` | Sửa sang lọc từ khóa |
| `/rules on <id>` | Bật luật |
| `/rules off <id>` | Tắt luật (giữ lại, không xóa) |
| `/rules del <id>` | Xóa luật (id trống có thể được tái dùng lần tạo sau) |

**Ví dụ:**

```
/rules
/rules set 3 9045222,9045333 all
/rules off 3
/rules on 3
/rules del 3
```

#### `/keywords` — gán từ khóa cho luật

```
/keywords <id_luật> <từ_khóa1,từ_khóa2,...>
```

Ví dụ: `/keywords 3 sale,hot,vip`  
Xem id luật bằng `/rules`.

### Tạm dừng / bật lại chuyển tiếp

| Lệnh | Mô tả |
|------|--------|
| `/pause` | Tạm dừng relay (không forward) |
| `/resume` | Bật lại relay (cần đã `/login` và session còn) |

---

## Lệnh admin

Chỉ dùng được sau `/iamadmin <mật_khẩu>` (hoặc id đã seed trong env).

| Lệnh | Mô tả |
|------|--------|
| `/adminhelp` | Trợ giúp admin |
| `/pending` | Danh sách user chờ duyệt |
| `/approve <id>` | Duyệt (`id` = tenant id hoặc bot user id) |
| `/reject <id>` | Từ chối đăng ký |
| `/users` | Danh sách user / tenant |
| `/tenant <id>` | Chi tiết một tenant (session, luật…) |
| `/suspend <id>` | Khóa tài khoản |
| `/unsuspend <id>` | Mở khóa → `approved` (user có thể cần `/resume`) |
| `/admins` | Danh sách admin đã lưu DB |
| `/revokeadmin <zalo_user_id>` | Gỡ quyền admin DB (không tự gỡ chính mình bằng lệnh này) |

Khi có user mới `/start`, admin thường nhận thông báo kèm gợi ý `/approve <id>`.

Chi tiết vận hành server/env: xem [ADMIN.vi.md](./ADMIN.vi.md).

---

## Forward hoạt động thế nào?

1. Bạn chat **Official Bot** chỉ để lệnh (`/login`, `/addrule`…).
2. Nick đã `/login` lắng nghe **group Zalo** (không phải chat 1-1 với Official Bot).
3. Tin trong **group nguồn** khớp luật → bot gửi sang **group đích**.
4. Nội dung: text / caption / ảnh; tin RTF (in đậm, màu…) được cố gắng giữ style khi gửi lại.
5. Không gắn tên người gửi vào tin chuyển tiếp (copy nội dung gốc).

---

## Sự cố thường gặp

| Hiện tượng | Cách xử lý |
|------------|------------|
| Chưa dùng được lệnh | `/start` → chờ admin duyệt → `/status` |
| QR không hiện / không quét được | Mở **link** QR trong chat; kiểm tra mạng server (`QR_TEMP_UPLOAD=true`) |
| `/groups` trống | Nick đã vào group chưa? Thử `/logout` → `/login` lại |
| Không forward | `/status`: approved? session active? relay on? Luật đúng **id group** từ `/groups`? |
| Listener chết đột ngột | Đừng mở Zalo Web cùng nick; `/logout` → `/login` |
| Vòng lặp tin | Không tạo A→B và B→A cùng lúc |

---

## Tóm tắt lệnh (cheat sheet)

```
# User
/start
/login | /logout | /groups | /status
/addrule <nguồn> <đích,...> all
/addrule <nguồn> <đích,...> keywords a,b
/rules | /rules set <id> <đích,...> all
/rules on|off|del <id>
/keywords <id> a,b
/pause | /resume
/help | /help addrule
/whoami | /cancel

# Admin
/iamadmin <mật_khẩu>
/pending | /approve <id> | /reject <id>
/users | /tenant <id>
/suspend <id> | /unsuspend <id>
/admins | /revokeadmin <zalo_user_id>
/adminhelp
```
