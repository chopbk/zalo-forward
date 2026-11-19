export const USER_HELP = `Zalo Message Forward — lệnh chính

Setup:
1) /start — đăng ký (chờ admin duyệt)
2) /login — quét QR nick Zalo (nên nick phụ)
   /stop — tạm dừng login QR đang chờ quét
3) /groups — lấy id group
4) /addrule ... — Zalo→Zalo
5) Telegram (mỗi tenant 1 forum):
   /tgbind <forum_id> → /tgadmins <tg_user_id,...>
   /addtg <nguồn> all  (hoặc trong forum: /useradd)
6) /rules — xem / sửa / bật / tắt / xóa

/addrule:
/addrule <id_nguồn> <id_đích,...> all
/addrule <id_nguồn> tg all

/addtg (cần đã /tgbind):
/addtg <id_nguồn> all
/addtg <id_nguồn> all readonly

Chi tiết: /help addrule · /help addtg

Lệnh khác:
/status · /tgstatus · /tgbind · /tgadmins · /tgunbind
/rules set <id> <đích,...> all
/rules on|off|del <id>
/keywords <id_luật> <từ_khóa,...>
/pause | /resume
/stop — dừng /login QR đang chờ
/logout
/whoami
/iamadmin <mật_khẩu>
/help

Lưu ý: automation Zalo không chính thức — rủi ro hạn chế nick.`;

export const ADD_RULE_HELP = `Hướng dẫn /addrule — 1 lệnh duy nhất

Format:
/addrule <id_nguồn> <id_đích1,id_đích2,...> all
/addrule <id_nguồn> <id_đích1,id_đích2,...> keywords <kw1,kw2,...>
/addrule <id_nguồn> tg all
/addrule <id_nguồn> tg,9045… all

Tham số:
• id_nguồn — 1 group (lấy từ /groups)
• id_đích — group Zalo và/hoặc token tg (tạo topic forum)
• all — forward mọi tin text/ảnh/link
• keywords — chỉ tin chứa ≥1 từ khóa

Ví dụ Zalo→Zalo:
/addrule 9045123456789012345 9045987654321098765,9045111222333444555 all

Ví dụ Zalo→Telegram topic:
/addrule 9045123456789012345 tg all
(hoặc /addtg 9045123456789012345 all)

Sau khi tạo:
/rules — liệt kê
/tgstatus — kiểm tra Telegram
/rules set 3 tg,9045222 all
/rules off 3 | /rules on 3 | /rules del 3

Mẹo:
• Cùng nguồn A, muốn thêm đích C: /addrule A B,C all
• /addtg giữ đích Zalo cũ, chỉ thêm topic
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
