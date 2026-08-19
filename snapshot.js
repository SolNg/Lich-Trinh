// snapshot.js — tầng dữ liệu «bản chụp theo từng tầng» cho khung kết xuất trong tầng của Phác Họa
//
// Bối cảnh (2026-08-05, tái cấu trúc khung kết xuất trong tầng): khối Điểm/Lịch/Tuyến trong tầng vốn chỉ gắn ở tầng mới nhất
// và luôn hiển thị trạng thái mới nhất của toàn cục, nên cuộn ngược lên tầng cũ thì lại thấy phần đã bị ghi đè — một thứ "lịch sử giả".
// Module này đóng băng trạng thái Điểm/Tuyến/Lịch/mốc thời gian **đúng lúc tầng AI đó được sinh ra / được đẩy tiến** thành một bản chụp,
// buộc vào chính message đó và đi theo bản lưu chat. Cuộn ngược lên → dựng lại từ bản chụp của tầng ấy →
// thấy đúng «trạng thái thế giới lúc đó» của tầng đó (lịch sử thật).
//
// Vì sao lưu vào message.extra chứ không mở một cấu trúc mới trong chat_metadata:
//   - Xóa tầng / sửa rồi xóa tầng → SillyTavern xóa cả message lẫn extra, bản chụp tự biến mất, coi như được tặng luôn tính năng «xóa lịch sử»;
//   - swipe → extra vốn dĩ đã tách riêng theo từng swipe (xem phần ghi kép bên dưới), trượt tới bản nào thì xem bản chụp của bản đó;
//   - Không thể lấy mesId làm khóa để lưu chỗ khác: mesId là chỉ số mảng, xóa tầng là bị dồn lên và lệch hết.
//
// ⚠️ Ghi kép cho swipe (xem chú thích trong mã nguồn ST, script.js ~12341): chat[floor].extra chỉ là bản soi của **swipe hiện tại**,
//   thứ thật sự đi theo swipe/xóa tầng/quay lui nhánh là swipe_info[swipe_id].extra. Nếu chỉ ghi vào extra thì người dùng trượt đi rồi
//   trượt về sẽ bị swipe_info cũ ghi đè và mất bản chụp. Vì vậy khi ghi thì ghi cả hai chỗ, còn khi đọc thì chỉ đọc extra (ST lúc đổi swipe
//   sẽ tự đồng bộ swipe_info[i].extra trở lại extra).
//
// Bản chụp **không vào prompt**: ST khi ghép ngữ cảnh chỉ lấy message.mes, còn extra thuần là siêu dữ liệu (số token/bản dịch/hình ảnh…
//   các tiện ích khác đều lưu ở đó), nhét bản chụp vào cũng không làm bẩn ngữ cảnh của AI.
//
// Lưu xuống bằng saveChatDebounced (chống dội, không chặn), né đỉnh I/O đồng bộ của saveChat (một trong những gốc rễ gây giật cho ST).

import { getContext } from '../../../extensions.js';

// Các khóa trên message.extra, có tiền tố gouhua_ để khỏi đụng với tiện ích khác.
const SNAP_KEY = 'gouhua_snapshot';

// Phiên bản schema hiện tại của bản chụp. Các trường chỉ thêm chứ không sửa, trường mới thì nối vào cuối và không bắt buộc (theo đúng kỷ luật
// tiến hóa định dạng xưa nay của Phác Họa); bản chụp cũ thiếu trường thì phía đọc tự bù giá trị mặc định, không ép chuyển đổi.
const SNAP_VERSION = 1;

function ctx() {
    try { return getContext?.() || null; } catch { return null; }
}

// Lấy object message của tầng thứ mesId (chỉ có ý nghĩa với tầng AI, bên gọi tự lo việc lọc).
function messageAt(mesId) {
    const c = ctx();
    const chat = c?.chat;
    if (!Array.isArray(chat)) return null;
    const i = Number(mesId);
    if (!Number.isInteger(i) || i < 0 || i >= chat.length) return null;
    return chat[i] || null;
}

// ── Ghi ──────────────────────────────────────────────────────────────────
// Hình dạng của snap (tất cả đều có thể trống, thiếu phần nào thì phía kết xuất không vẽ phần đó):
//
//     point   : chuỗi raw của Điểm (<calendar_widget>…)
//     line    : chuỗi raw của Tuyến (chứa <line_widget>… hoặc raw trong cache của Tuyến)
//     almanac : mảng các mục Lịch (kết quả đã chuẩn hóa của loadAlmanac())
//     anchor  : { month, day } — mốc «hôm nay» lúc bấy giờ
//     pool    : [Tầng AI] các mục rút gọn trong «kho đánh dấu» của sổ ngầm lúc đó [{id,suViec,loai,mocDau,chuKy,mocHan,nhan,khoa,imLang}] (trường mới · ở cuối · không bắt buộc)
//     recall  : [Tầng người dùng] phần hiển thị lại nội dung được gọi lại và tiêm trong lượt đó [{id,suViec,loai,mocDau,hienTrang}] (bản đầy đủ; trường mới · ở cuối · không bắt buộc)
//   (Trường cũ ledger — bản chỉ-đọc thời kỳ đầu — đã ngừng dùng; phía đọc bỏ qua thẳng trường ledger của bản chụp cũ, để lại cũng vô hại.)
//
// Tầng người dùng cũng lưu bản chụp: khung gọi lại gắn ở tầng người dùng và cần xem được phần gọi lại của lượt đó ở các tầng cũ, nên bỏ giới hạn «chỉ gắn cho tầng AI» ban đầu.
// Ở tầng người dùng thì point/line/almanac luôn trống (chỉ recall có nội dung), tầng AI thì ngược lại chỉ có pool — hai loại loại trừ nhau nhưng dùng chung một schema.
//
// Lũy đẳng / tiết kiệm lượt ghi: nếu bằng đúng bản chụp đang có (so theo JSON) thì bỏ qua (không đụng extra, không kích hoạt lưu),
//   tránh việc mỗi lần sync đều đánh dấu chat là bẩn khiến bộ chống dội không bao giờ chạm được tới lúc ghi xuống đĩa.
export function writeSnapshot(mesId, snap) {
    const msg = messageAt(mesId);
    if (!msg) return false;

    const payload = {
        v: SNAP_VERSION,
        ts: Date.now(),
        point:   snap?.point   || '',
        line:    snap?.line    || '',
        almanac: Array.isArray(snap?.almanac) ? snap.almanac : [],
        anchor:  (snap?.anchor && Number.isFinite(+snap.anchor.month) && Number.isFinite(+snap.anchor.day))
            ? { month: +snap.anchor.month, day: +snap.anchor.day }
            : null,
        pool:    Array.isArray(snap?.pool)   ? snap.pool   : [],
        recall:  Array.isArray(snap?.recall) ? snap.recall : [],
    };

    // Lũy đẳng: nội dung không đổi thì không ghi (ts không tham gia so sánh, nếu không sẽ luôn "có đổi").
    const prev = msg.extra?.[SNAP_KEY];
    if (prev && _sameSnapContent(prev, payload)) return false;

    if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
    msg.extra[SNAP_KEY] = payload;

    // Ghi kép: soi sang swipe_info[swipe_id].extra của swipe hiện tại, để quay lui đúng theo swipe/xóa tầng/nhánh.
    _mirrorToCurrentSwipe(msg, payload);

    ctx()?.saveChatDebounced?.();
    return true;
}

// Tương đương về nội dung (bỏ qua khác biệt ts / v — khi nâng v thì đã có đường chuyển đổi riêng, ở đây chỉ xét nội dung thực chất).
function _sameSnapContent(a, b) {
    if (a.point !== b.point) return false;
    if (a.line !== b.line) return false;
    const am = a.anchor, bm = b.anchor;
    if (!!am !== !!bm) return false;
    if (am && bm && (am.month !== bm.month || am.day !== bm.day)) return false;
    // Các mục Lịch: so thô bằng JSON (là mảng, lượng nhỏ; thứ tự do loadAlmanac đưa ra ổn định).
    try {
        if (JSON.stringify(a.almanac || []) !== JSON.stringify(b.almanac || [])) return false;
    } catch { return false; }
    // Kho đánh dấu (tầng AI) / phần gọi lại (tầng người dùng): cũng so thô bằng JSON (lượng nhỏ, thứ tự do phía lấy dữ liệu đưa ra ổn định).
    try {
        if (JSON.stringify(a.pool   || []) !== JSON.stringify(b.pool   || [])) return false;
        if (JSON.stringify(a.recall || []) !== JSON.stringify(b.recall || [])) return false;
    } catch { return false; }
    return true;
}

// Soi bản chụp vào ô swipe hiện tại. swipe_info của ST song song với mảng swipes, chỉ số chính là swipe_id;
// ô chưa tồn tại (tin nhắn cũ / chỉ có một swipe) thì bù thêm cho tới id hiện tại, chỉ đụng extra chứ không đụng phần văn bản message/swipes.
function _mirrorToCurrentSwipe(msg, payload) {
    const sid = Number(msg.swipe_id);
    if (!Number.isInteger(sid) || sid < 0) return;   // tầng không có khái niệm swipe: chỉ cần extra là đủ
    if (!Array.isArray(msg.swipe_info)) return;       // không có swipe_info: không tự tạo, tránh làm loạn cấu trúc của ST
    let slot = msg.swipe_info[sid];
    if (!slot || typeof slot !== 'object') { slot = msg.swipe_info[sid] = {}; }
    if (!slot.extra || typeof slot.extra !== 'object') slot.extra = {};
    slot.extra[SNAP_KEY] = payload;
}

// ── Đọc ──────────────────────────────────────────────────────────────────
// Chỉ đọc message.extra (khi đổi swipe, ST đã tự đồng bộ swipe_info[i].extra trở lại extra).
// Trả về null = tầng đó không có bản chụp (tầng cũ từ trước lần tái cấu trúc / chưa từng được sinh ra) → phía kết xuất dựa vào đó mà không hiện khối.
export function readSnapshot(mesId) {
    const msg = messageAt(mesId);
    const snap = msg?.extra?.[SNAP_KEY];
    if (!snap || typeof snap !== 'object') return null;
    // Chuẩn hóa chịu lỗi: bản chụp cũ/bẩn thiếu trường thì bù mặc định, để phía đọc luôn nhận được một hình dạng cố định.
    return {
        v: Number.isFinite(+snap.v) ? +snap.v : 0,
        ts: +snap.ts || 0,
        point:   typeof snap.point === 'string' ? snap.point : '',
        line:    typeof snap.line  === 'string' ? snap.line  : '',
        almanac: Array.isArray(snap.almanac) ? snap.almanac : [],
        anchor:  (snap.anchor && Number.isFinite(+snap.anchor.month) && Number.isFinite(+snap.anchor.day))
            ? { month: +snap.anchor.month, day: +snap.anchor.day }
            : null,
        pool:    Array.isArray(snap.pool)   ? snap.pool   : [],
        recall:  Array.isArray(snap.recall) ? snap.recall : [],
    };
}

export { SNAP_KEY, SNAP_VERSION };
