// ledger.js — tầng lưu trữ của Sổ Ngầm (đánh dấu thời gian / shadow ledger) trong Phác Họa
//
// Động cơ: AI ở tầng chính nhớ được sự kiện, nhưng không tính nổi «cách đây bao lâu / bây giờ đáng lẽ đang ở trạng thái nào» —
// vết thương một tuần lẽ ra đã lên da non thì vẫn gào đau nhức, kinh nguyệt tháng trước lại tưởng là hôm qua. Sổ Ngầm mở thêm một lớp
// «sổ thời gian» bên ngoài Điểm/Tuyến/Diện: vớt sự kiện từ chính văn → đánh dấu (lúc này · việc này · trạng thái này)
// → cứ mỗi N tầng lại tính lại khoảng cách thời gian để làm mới hiện trạng → tiêm vào tầng chính dưới dạng nhắc nhở mạnh,
// để tầng chính chỉ việc diễn đạt cái kết luận đã được nhai sẵn, khỏi tự tính.
//
// File này chỉ lo [tầng lưu trữ]: đọc/ghi chat_metadata['sp-ledger'] và schema dùng chung. Phần đánh dấu/phán định/tiêm/giao diện/tra cứu
// đều là các lát cắt sau, không nằm ở đây. Cách lưu theo đúng memory.js / store.js: saveMetadata() ghi xuống đĩa đồng bộ (khi đổi bản lưu,
// clearChat() sẽ hủy lượt lưu chống dội và dọn sạch chat_metadata, nên bản chống dội sẽ mất vĩnh viễn — bắt buộc phải ghi đồng bộ).
//
// Danh sách trắng OWN_KEYS đã có sẵn 'sp-ledger' → bảng quản lý lưu trữ tự hiển thị dung lượng và cho dọn thông qua store.ownKeyBytes / clearOwnKey,
// module này không cần đấu nối gì thêm (hai hàm đó đọc thẳng chat_metadata theo chuỗi key, chẳng liên quan tới việc module này có được import hay không).

import { getContext } from '../../../extensions.js';

const LEDGER_KEY     = 'sp-ledger';
const SCHEMA_VERSION = 1;

// Schema dùng chung (bản thiết kế số ba · một bộ trường lo hết mọi loại). Sự kiện một lần và sự kiện chu kỳ không phải hai kiểu dữ liệu khác nhau,
// chúng chỉ khác nhau ở chỗ khi kết thúc thì «bỏ đi hay lăn sang vòng kế». Trường mới nhất loạt nối vào cuối và không bắt buộc, đừng chèn vào giữa.
//   loai      : 'trạng thái kéo dài' | 'hẹn cần làm' | 'chu kỳ'
//   trangThai : 'hoạt động' | 'đã kết' (kết thúc chỉ lật cờ, mặc định bị lọc khỏi danh sách, không xóa vật lý — người dùng vớt lại được)
//   khoa      : '' | 'người dùng khóa' (người dùng đã tự sửa → cỗ máy phán định không được đụng nữa, theo đúng cơ chế khóa của Điểm/Tuyến)
//   imLang    : false | true (tạm ngưng cài vào: vẫn hoạt động, cỗ máy phán định vẫn làm mới hiện trạng, nhưng không tiêm vào tầng chính và cũng
//               không cho cỗ máy phán định tự lưu trữ — nghĩa là «giờ chưa muốn nó bị nhắc đi nhắc lại mỗi lượt, nhưng cũng chưa xong». Trực giao với «khóa»: khóa thì đóng băng nội dung, im lặng thì ngưng tiêm)
//   mocDau/mocHienTai : { tang, ngayLich }. mocDau = sổ gốc, đóng đinh không bao giờ đổi; mocHienTai = sổ sống, mỗi lượt phán định lại làm mới.
//     ngayLich cùng nguồn với almTodayAnchor() của Lịch (hình dạng {month,day}), ở đây chỉ lưu chứ không diễn giải.
//   chuKy     : chỉ dành cho «chu kỳ», số ngày (ví dụ 30)
//   mocHan    : chỉ dành cho «hẹn cần làm/chu kỳ», { ngayLich } (ngày lịch của lần kế tiếp; hẹn chưa chốt lịch thì để trống)
const TYPES  = ['trạng thái kéo dài', 'hẹn cần làm', 'chu kỳ'];
const STATES = ['hoạt động', 'đã kết'];

// ═══════════════════════════════════════════════════════════════════════════
//  Đọc/ghi chat_metadata (theo đúng kiểu store()/persist() của store.js: đường đọc không khởi tạo vỏ rỗng)
// ═══════════════════════════════════════════════════════════════════════════

function freshMeta() {
    return { version: SCHEMA_VERSION, entries: [], seq: 0 };
}

// Lấy sp-ledger của chat hiện tại. Không có chat thì trả về null.
// create=false (đường đọc): không tồn tại thì trả null, **tuyệt đối không khởi tạo** — nếu không, chỉ «đọc một cái» cũng nhét
//   vỏ rỗng vào chatMetadata và làm bẩn bản lưu chat. create=true (đường ghi): khởi tạo khi cần + đồng bộ cấu trúc/phiên bản.
// Mỗi lần đều gọi getContext() mới, không cache — CHAT_CHANGED thay tham chiếu chatMetadata, cache sẽ đọc nhầm chat cũ.
function ledger(create = false) {
    const ctx = getContext?.();
    if (!ctx || !ctx.chatId) return null;
    const cm = ctx.chatMetadata;
    if (!cm) return null;
    let m = cm[LEDGER_KEY];
    if (!m || typeof m !== 'object') {
        if (!create) return null;
        m = cm[LEDGER_KEY] = freshMeta();
    }
    if (!Array.isArray(m.entries)) m.entries = [];
    if (!Number.isFinite(+m.seq))  m.seq = 0;
    if (m.version !== SCHEMA_VERSION) {
        m.version = SCHEMA_VERSION;   // v1 là bản đầu, chưa có cấu trúc cũ nào cần chuyển đổi; sau này nâng phiên bản thì bổ sung ở đây
        if (create) persist();
    }
    return m;
}

function persist() {
    // Ghi xuống đĩa ngay, đừng dùng saveMetadataDebounced: khi đổi bản lưu, clearChat() sẽ gọi cancelDebouncedMetadataSave()
    // để hủy lượt chống dội chưa kịp chạy, rồi ngay sau đó chat_metadata={}, thế là bản chống dội vĩnh viễn không xuống đĩa → mất Sổ Ngầm.
    // saveMetadata() chụp đồng bộ rồi ghi theo diff patch (không đổi thì no-op), viết ra tại chỗ, đổi bản lưu cũng không hủy được. Bản ST cũ không có API này thì lùi về chống dội.
    const ctx = getContext?.();
    if (!ctx) return;
    if (ctx.saveMetadata) ctx.saveMetadata();
    else ctx.saveMetadataDebounced?.();
}

// ═══════════════════════════════════════════════════════════════════════════
//  Chuẩn hóa (vào kho là bù đủ giá trị mặc định, bảo đảm mọi mục trong kho đều đủ schema)
// ═══════════════════════════════════════════════════════════════════════════

// Mốc → { tang, ngayLich }. tang không phải số hữu hạn thì để null; ngayLich truyền thẳng nguyên trạng ({month,day} hoặc chuỗi, cùng nguồn với Lịch).
function normalizeAnchor(a) {
    if (!a || typeof a !== 'object') return { tang: null, ngayLich: null };
    return {
        tang  : Number.isFinite(+a.tang) ? +a.tang : null,
        ngayLich: a.ngayLich ?? null,
    };
}

function strArr(v) {
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
}

// Bù một object lỏng lẻo từ bên ngoài thành mục đầy đủ. id do addEntry cấp, ở đây chỉ bù khi thiếu.
function normalizeEntry(obj, id) {
    const o = (obj && typeof obj === 'object') ? obj : {};
    return {
        id      : id || o.id || '',
        suViec    : String(o.suViec || '').trim(),
        loai    : TYPES.includes(o.loai) ? o.loai : 'trạng thái kéo dài',
        lienDoi    : strArr(o.lienDoi),
        nhan    : strArr(o.nhan),
        mocDau  : normalizeAnchor(o.mocDau),
        hienTrang    : String(o.hienTrang || '').trim(),
        mocHienTai  : normalizeAnchor(o.mocHienTai),
        chuKy: Number.isFinite(+o.chuKy) ? +o.chuKy : null,   // chỉ dành cho «chu kỳ»
        mocHan  : o.mocHan ? normalizeAnchor(o.mocHan) : null,          // chỉ dành cho «hẹn cần làm/chu kỳ»
        trangThai    : o.trangThai === 'đã kết' ? 'đã kết' : 'hoạt động',
        khoa      : o.khoa === 'người dùng khóa' ? 'người dùng khóa' : '',
        ts      : Number.isFinite(+o.ts) ? +o.ts : Date.now(),         // dấu thời gian lúc đánh dấu (trường mới · ở cuối · không bắt buộc)
        imLang    : o.imLang === true,                                 // tạm ngưng cài vào (trường mới · ở cuối · không bắt buộc): ngưng tiêm, cỗ máy phán định không lưu trữ, vẫn hoạt động
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Đọc / ghi / xóa (API chính đối ngoại)
// ═══════════════════════════════════════════════════════════════════════════

// Liệt kê các mục. Mặc định chỉ trả về mục «hoạt động»; includeClosed=true thì trả về cả mục đã kết (dùng cho quản lý lưu trữ/kho lưu trữ).
export function listEntries({ includeClosed = false } = {}) {
    const m = ledger();
    if (!m) return [];
    return m.entries.filter(e => includeClosed || e.trangThai !== 'đã kết');
}

export function getEntry(id) {
    const m = ledger();
    if (!m) return null;
    return m.entries.find(e => e.id === id) || null;
}

// Đánh dấu và đưa vào kho. Trả về mục đã được bù đầy đủ (kèm id được cấp); không có chat thì trả null.
export function addEntry(obj) {
    const m = ledger(true);
    if (!m) return null;
    const id = `L${++m.seq}`;
    const entry = normalizeEntry(obj, id);
    m.entries.push(entry);
    persist();
    return entry;
}

// Cập nhật cục bộ (cỗ máy phán định làm mới hienTrang/mocHienTai, hoặc người dùng sửa nội tuyến). Chỉ đổi những khóa được truyền vào. Trả về có trúng mục nào không.
// Lưu ý: trước khi gọi, cỗ máy phán định phải tự chặn những mục có khoa='người dùng khóa' (tầng này không chặn, để cho tầng trên quyết chiến lược).
export function updateEntry(id, patch) {
    const m = ledger();
    if (!m || !patch || typeof patch !== 'object') return false;
    const e = m.entries.find(x => x.id === id);
    if (!e) return false;
    Object.assign(e, patch);
    persist();
    return true;
}

// Kết mềm: trangThai → đã kết (không xóa vật lý, mặc định bị lọc khỏi danh sách, người dùng vớt lại được). Sự kiện một lần đã thực hiện xong/đã lành thì đi đường này.
export function closeEntry(id) {
    return updateEntry(id, { trangThai: 'đã kết' });
}

// Vớt lại: đã kết → hoạt động (thao tác ngược của closeEntry; hồi sinh thủ công trong khu lưu trữ, cỗ máy phán định theo dõi lại).
export function reopenEntry(id) {
    return updateEntry(id, { trangThai: 'hoạt động' });
}

// Người dùng sửa là khóa chết cỗ máy phán định của AI (theo đúng cơ chế khóa của Điểm/Tuyến).
export function lockEntry(id) {
    return updateEntry(id, { khoa: 'người dùng khóa' });
}
export function unlockEntry(id) {
    return updateEntry(id, { khoa: '' });
}

// Tạm ngưng cài vào / khôi phục (trực giao với khóa: khóa lo chuyện «cỗ máy phán định có được sửa nội dung không», im lặng lo chuyện «có tiêm vào tầng chính không»).
// Trong lúc im lặng: không vào tập được tiêm, không vào phần gọi lại, cỗ máy phán định không được tự lưu trữ và kết nó (hiện trạng vẫn làm mới theo số ngày). Vẫn là «hoạt động», chưa phải «đã kết».
export function muteEntry(id) {
    return updateEntry(id, { imLang: true });
}
export function unmuteEntry(id) {
    return updateEntry(id, { imLang: false });
}

// Xóa vật lý (thường không dùng — kết thì đi qua closeEntry đánh dấu mềm; chỉ dùng khi người dùng chủ động xóa từng mục trong phần quản lý lưu trữ).
export function removeEntry(id) {
    const m = ledger();
    if (!m) return false;
    const i = m.entries.findIndex(x => x.id === id);
    if (i < 0) return false;
    m.entries.splice(i, 1);
    persist();
    return true;
}

export { LEDGER_KEY, SCHEMA_VERSION, TYPES, STATES, normalizeEntry };
