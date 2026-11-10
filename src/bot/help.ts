export const USER_HELP = `Zalo Message Forward — lệnh chính

Làm lần lượt:
1) /start — đăng ký (chờ admin duyệt)
2) /login — quét QR nick Zalo cá nhân (nên dùng nick phụ)
3) /groups — xem id các group
4) /addrule — tạo luật chuyển tiếp (wizard từng bước)
5) /rules — xem / bật / tắt / xóa luật

Lệnh khác:
/status — trạng thái duyệt + session + số luật
/keywords — thêm từ khóa cho luật đã có
/pause | /resume — tắt / bật chuyển tiếp
/logout — đăng xuất nick cá nhân
/cancel — hủy wizard đang làm
/whoami — xem Zalo user id của bạn
/iamadmin <mật khẩu> — nhận quyền admin (lần đầu)
/help — menu này
/help addrule — hướng dẫn /addrule CHI TIẾT

Lưu ý: automation Zalo không chính thức — rủi ro hạn chế nick.`;

/** Chi tiết wizard /addrule — gửi riêng vì dài */
export const ADD_RULE_HELP = `Hướng dẫn /addrule (chi tiết)

Mục tiêu: tin từ 1 group NGUỒN → nhiều group ĐÍCH.

Ví dụ:
  Group A (id 111) → Group 1 (222), Group 2 (333)
  Chỉ forward tin có chữ "sale" hoặc "hot"

——— Chuẩn bị ———
1. /login thành công
2. /groups → copy đúng id (chuỗi số dài), ví dụ:
   1. Team Sale — id=9045123456789012345
   2. Group KH — id=9045987654321098765

——— Cách dùng ———
Gõ: /addrule
Bot hỏi từng bước — bạn trả lời tin nhắn thường (không cần /):

Bước 1 — Group NGUỒN
  Gửi 1 id, ví dụ:
  9045123456789012345

Bước 2 — Group ĐÍCH
  Một hoặc nhiều id, cách nhau bằng dấu phẩy:
  9045987654321098765,9045111222333444555
  (không gửi trùng id nguồn)

Bước 3 — Kiểu lọc
  Trả lời số:
  1 = tất cả tin (text/ảnh/link)
  2 = chỉ tin khớp từ khóa

Bước 4 — (chỉ khi chọn 2) Từ khóa
  Cách nhau bằng dấu phẩy, không phân biệt hoa thường:
  sale, hot, giảm giá

Bước 5 — Xác nhận
  ok = lưu luật
  không = hủy

——— Sau khi tạo ———
/rules — xem danh sách (#id luật)
/rules off 3 — tắt luật #3
/rules on 3 — bật lại
/rules del 3 — xóa luật #3
/keywords — thêm từ khóa cho luật đã có

——— Mẹo ———
/cancel — hủy giữa chừng
Muốn nhiều nguồn: chạy /addrule nhiều lần (mỗi lần 1 nguồn)
Tránh tạo A→B và B→A (dễ vòng lặp; bot sẽ cảnh báo)`;

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

/** Prompt mở wizard /addrule */
export const ADDRULE_START = `Thêm luật chuyển tiếp (wizard)

Ví dụ: Group A → Group 1,2,3

Bước 1/5 — Gửi ID group NGUỒN
(Lấy từ /groups — chỉ gửi 1 id, ví dụ: 9045123456789012345)

Gõ /cancel để hủy.
Chi tiết đầy đủ: /help addrule`;
