export const USER_HELP = `Zalo Message Forward — lệnh chính

Setup:
1) /start — đăng ký (chờ admin duyệt)
2) /login — quét QR nick Zalo (nên nick phụ)
3) /groups — lấy id group
4) /addrule ... — tạo luật (1 lệnh)
5) /rules — xem / bật / tắt / xóa

/addrule (format đầy đủ):
/addrule <id_nguồn> <id_đích,...> all
/addrule <id_nguồn> <id_đích,...> keywords <từ_khóa,...>

Ví dụ:
/addrule 9045111 9045222,9045333 all
/addrule 9045111 9045222,9045333 keywords sale,hot

Chi tiết: /help addrule

Lệnh khác:
/status
/rules on|off|del <id>
/keywords <id_luật> <từ_khóa,...>
/pause | /resume
/logout
/whoami
/iamadmin <mật_khẩu>
/help

Lưu ý: automation Zalo không chính thức — rủi ro hạn chế nick.`;

export const ADD_RULE_HELP = `Hướng dẫn /addrule — 1 lệnh duy nhất

Format:
/addrule <id_nguồn> <id_đích1,id_đích2,...> all
/addrule <id_nguồn> <id_đích1,id_đích2,...> keywords <kw1,kw2,...>

Tham số:
• id_nguồn — 1 group (lấy từ /groups)
• id_đích — một hoặc nhiều, cách nhau dấu phẩy (không trùng nguồn)
• all — forward mọi tin text/ảnh/link
• keywords — chỉ tin chứa ≥1 từ khóa (không phân biệt hoa thường)

Ví dụ 1 — forward tất cả từ A sang 1 và 2:
/addrule 9045123456789012345 9045987654321098765,9045111222333444555 all

Ví dụ 2 — chỉ tin có "sale" hoặc "hot":
/addrule 9045123456789012345 9045987654321098765 keywords sale,hot

Sau khi tạo:
/rules — liệt kê
/rules off 3 | /rules on 3 | /rules del 3
/keywords 3 deal,vip — thêm từ khóa cho luật #3

Mẹo:
• Nhiều nguồn = gọi /addrule nhiều lần
• Tránh A→B và B→A (vòng lặp; bot cảnh báo)`;

export const ADMIN_HELP = `Lệnh admin:
/pending — chờ duyệt
/approve <id> — duyệt
/reject <id>
/users — danh sách user
/suspend <id> | /unsuspend <id>
/tenant <id> — chi tiết
/admins — danh sách admin (DB)
/revokeadmin <zalo_user_id> — gỡ admin DB
/adminhelp — trợ giúp admin`;
