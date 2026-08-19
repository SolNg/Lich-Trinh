// store.js — lớp lưu trữ hợp nhất của Phác Họa (Điểm/Tuyến/Diện/Gian → chat_metadata)
//
// Bối cảnh: Điểm(schedule)/Tuyến(lines)/Diện(outline)/thảo luận Diện(creative-chat)/Gian(space-chat)
// vốn nằm rải rác trong localStorage (key = sp-cache-{chatId}-{kind}-{scope}, xem state.js), đổi trình
// duyệt hoặc xóa cache là mất, lại không đi kèm file chat và không đồng bộ giữa các thiết bị. Module này
// gom chúng vào một key cấp cao duy nhất `sp-store` trong chat_metadata, để SillyTavern tuần tự hóa cùng
// file chat xuống thư mục data/ trên máy chủ — thoát khỏi trình duyệt, dùng chung nhiều thiết bị, chỉ giữ bản mới nhất.
//
// Ký ức (sp-memory) và lớp vĩnh viễn của Lăng (sp-theater) đã có key riêng cùng schema riêng trong
// chat_metadata; module này không đụng tới chúng. Neo (mục đã lưu) là dữ liệu toàn cục, đi qua /api/files, cũng không nằm ở đây.
//
// Hình dạng dữ liệu (khóa con = `{kind}-{scope}`, scope = user | char-<encodeURIComponent(name)>):
//   chat_metadata['sp-store'] = {
//     version: 1,
//     data: {
//       'schedule-user'      : { raw, userName, ts },
//       'outline-user'       : { raw, ts },
//       'outline-char-Alice' : { raw, ts },
//       'lines-user'         : { raw, ts },
//       'dashed-user'        : { items: [ { id, text, createdAt, locked }, ... ], ts },
//       'creative-chat-user' : [ { role, content }, ... ],
//       'space-chat-user'    : [ ... ],
//     }
//   }
//
// Lằn ranh đỏ: bảng quản lý lưu trữ chỉ được thêm/xóa những key chat_metadata do chính Phác Họa sở hữu
// (xem OWN_KEYS). baibai_book / variables / LWB_SNAP v.v. là dữ liệu của plugin khác — chỉ đọc, tuyệt đối không xóa.

import { getContext } from '../../../extensions.js';

const STORE_KEY      = 'sp-store';
const SCHEMA_VERSION = 1;

// Các key cấp cao do chính Phác Họa sở hữu trong chat_metadata. Bảng điều khiển dựa vào đây để phân biệt "Phác Họa với plugin khác", đồng thời là danh sách trắng của clearOwnKey.
export const OWN_KEYS = ['sp-store', 'sp-memory', 'sp-theater', 'sp-ledger'];

// 7 nhóm dữ liệu được gom vào sp-store (theater-draft là bản nháp gắn với thiết bị, vẫn để trong localStorage, không nằm ở đây).
// dashed (đường đứt · mẩu kiến thức vui) và almanac (Lịch) đều không phân góc nhìn, lúc chạy luôn dùng scope user (khóa con luôn là dashed-user / almanac-user).
// Thứ tự không quan trọng, nhưng lưu ý không nhóm nào là tiền tố của nhóm nào — việc phân tích khóa con (usageByKind/clearKind) dựa vào điều này.
export const KINDS = ['schedule', 'outline', 'lines', 'creative-chat', 'space-chat', 'dashed', 'almanac'];

// ═══════════════════════════════════════════════════════════════════════════
//  scope / khóa con
// ═══════════════════════════════════════════════════════════════════════════

// Tái sử dụng quy tắc scope của state.js: góc nhìn char và có tên → char-<enc>, ngược lại là user.
function scopeOf(view, charName) {
    // .trim() để khớp với normalizeScopePart trong state.js, bảo đảm khóa con lúc chạy trùng khít với khóa con chuyển từ bản cũ sang.
    return (view === 'char' && charName)
        ? `char-${encodeURIComponent(String(charName).trim())}`
        : 'user';
}

// Khóa con = `{kind}-{scope}`. Lưu ý schedule ở đây **cũng mang tiền tố kind** (`schedule-user`),
// khác với khóa trần thời localStorage (`sp-cache-{chatId}-user`) — lúc chuyển đổi thì lớp store lo việc quy đổi.
export function subKey(kind, view = 'user', charName = '') {
    return `${kind}-${scopeOf(view, charName)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Đọc/ghi chat_metadata (theo đúng kiểu meta()/persist() của theater.js)
// ═══════════════════════════════════════════════════════════════════════════

function freshStore() {
    return { version: SCHEMA_VERSION, data: {} };
}

// Lấy sp-store của chat hiện tại. Không có chat thì trả về null.
// create=false (đường đọc): sp-store không tồn tại thì trả null, **tuyệt đối không khởi tạo** — nếu không, chỉ "đọc một cái"
//   cũng nhét vỏ rỗng vào chatMetadata, làm bẩn bản lưu chat, lại khiến bước chuyển đổi hiểu nhầm là "metadata đã có dữ liệu".
// create=true (đường ghi): khởi tạo khi cần và đồng bộ phiên bản.
// Mỗi lần đều gọi getContext() mới, không cache — CHAT_CHANGED sẽ thay tham chiếu chatMetadata, cache sẽ đọc nhầm chat cũ.
function store(create = false) {
    const ctx = getContext?.();
    if (!ctx || !ctx.chatId) return null;
    const cm = ctx.chatMetadata;
    if (!cm) return null;
    let s = cm[STORE_KEY];
    if (!s || typeof s !== 'object') {
        if (!create) return null;
        s = cm[STORE_KEY] = freshStore();
    }
    if (!s.data || typeof s.data !== 'object') s.data = {};
    // Việc đồng bộ phiên bản chỉ làm ở đường ghi: nếu đường đọc cũng nâng version trong bộ nhớ lên mới nhất mà không ghi xuống đĩa, không chuyển đổi,
    // thì sau này khi bump schema, đường ghi sẽ phán nhầm là «đã mới nhất» rồi bỏ qua bước chuyển đổi — dữ liệu vẫn nằm ở cấu trúc cũ nhưng lại mang số phiên bản mới.
    // Vì vậy đường đọc trả về nguyên trạng (version giữ đúng giá trị trên đĩa), việc chuyển đổi nhất loạt đẩy sang lần ghi kế tiếp (bổ sung logic chuyển đổi tại đây).
    if (create && s.version !== SCHEMA_VERSION) {
        // v1 là bản đầu, chưa có cấu trúc cũ nào cần chuyển đổi; khi nâng phiên bản sau này thì bổ sung ở đây.
        s.version = SCHEMA_VERSION;
        persist();
    }
    return s;
}

function persist() {
    // Ghi xuống đĩa ngay chứ không dùng saveMetadataDebounced: khi đổi bản lưu, clearChat() của ST sẽ gọi
    // cancelDebouncedMetadataSave() để hủy lượt lưu chống dội chưa kịp chạy, rồi ngay sau đó chat_metadata={},
    // thế là bản chống dội vĩnh viễn không xuống đĩa → mất Điểm/Tuyến/Diện và ký ức. saveMetadata() chụp đồng bộ chat_metadata,
    // đi theo diff patch (không đổi thì no-op), ghi xong là phát ngay, đổi bản lưu cũng không hủy được.
    const ctx = getContext?.();
    if (!ctx) return;
    if (ctx.saveMetadata) ctx.saveMetadata();
    else ctx.saveMetadataDebounced?.();   // đỡ: bản ST cũ không có saveMetadata
}

// Key cấp cao sp-store đã tồn tại hay chưa (không xét nội dung, cũng không khởi tạo).
export function hasStore() {
    const cm = getContext?.()?.chatMetadata;
    return !!(cm && cm[STORE_KEY] && typeof cm[STORE_KEY] === 'object');
}

// sp-store của chat hiện tại có **chứa dữ liệu Điểm/Tuyến/Diện/Gian thật** hay không (bỏ qua vỏ rỗng). Việc phát hiện xung đột khi chuyển đổi dùng hàm này, không dùng hasStore.
export function hasAnyData() {
    const s = store(false);
    if (!s) return false;
    return Object.keys(s.data).some(sk => kindOfSubKey(sk));
}

// ═══════════════════════════════════════════════════════════════════════════
//  Đọc / ghi / xóa (API chính đối ngoại, thay cho các lời gọi localStorage rải rác)
// ═══════════════════════════════════════════════════════════════════════════
//
// value là object/array trực tiếp (không JSON.stringify nữa) — chat_metadata giữ object sống, SillyTavern tuần tự hóa thống nhất khi lưu.

export function readData(kind, view = 'user', charName = '') {
    const s = store();
    if (!s) return null;
    const v = s.data[subKey(kind, view, charName)];
    return v == null ? null : v;
}

export function writeData(kind, view, charName, value) {
    const s = store(true);
    if (!s) return false;
    if (value == null) { removeData(kind, view, charName); return true; }
    s.data[subKey(kind, view, charName)] = value;
    persist();
    return true;
}

// Khi một nghiệp vụ cần cập nhật nhiều phần dữ liệu con cùng lúc, chỉ sửa object trong bộ nhớ một lần rồi ghi xuống đĩa một lượt, tránh việc
// đổi bản lưu xen vào giữa hai lần saveMetadata gây ra cảnh "chỉ ghi thành công một nửa". entries: [{ kind, view, charName, value }].
export function writeBatch(entries) {
    const list = Array.isArray(entries) ? entries.filter(it => it?.kind) : [];
    if (!list.length) return false;
    const s = store(true);
    if (!s) return false;
    for (const it of list) {
        const key = subKey(it.kind, it.view, it.charName);
        if (it.value == null) delete s.data[key];
        else s.data[key] = it.value;
    }
    persist();
    return true;
}

export function removeData(kind, view = 'user', charName = '') {
    const s = store();
    if (!s) return;
    const k = subKey(kind, view, charName);
    if (k in s.data) { delete s.data[k]; persist(); }
}

// Ghi thẳng theo khóa con nguyên bản (dùng khi chuyển đổi — lúc đó đã tính sẵn khóa con `{kind}-{scope}`, khỏi tách lại view/charName).
export function writeRaw(subKeyStr, value) {
    const s = store(true);
    if (!s || !subKeyStr) return false;
    s.data[subKeyStr] = value;
    persist();
    return true;
}

// Tên vừa nhập gần đây ở góc nhìn char (mỗi thẻ nhân vật một bản: theo sp-store vào chat_metadata, đổi thẻ là đổi bản).
// Lưu ở khóa con nguyên bản 'charnames-recent' — không thuộc 6 nhóm kind, kindOfSubKey trả về null, nên thống kê dung lượng
// và dọn theo kind đều bỏ qua nó; chỉ mất khi cả sp-store bị xóa (đúng với định vị "tiện ích phụ, đi theo cuộc trò chuyện").
const CHARNAMES_SUBKEY = 'charnames-recent';
export function readRecentCharNames() {
    const s = store();
    if (!s) return [];
    const v = s.data[CHARNAMES_SUBKEY];
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : [];
}
// Đưa name lên đầu, khử trùng lặp (phân biệt hoa thường, giữ nguyên dạng), chỉ giữ max mục gần nhất.
export function pushRecentCharName(name, max = 3) {
    const n = String(name || '').trim();
    if (!n) return;
    const s = store(true);
    if (!s) return;
    const prev = Array.isArray(s.data[CHARNAMES_SUBKEY]) ? s.data[CHARNAMES_SUBKEY] : [];
    const next = [n, ...prev.filter(x => x !== n)].slice(0, max);
    s.data[CHARNAMES_SUBKEY] = next;
    persist();
}

// Ô ghim cố định cho char (mỗi thẻ một bản, đi theo sp-store): khác về ngữ nghĩa với phần «vừa điền gần đây» ở trên —
//   recent = lịch sử tự cuộn (tên mới đẩy tên cũ ra), chỉ dùng làm chip điền nhanh cho ô nhập;
//   pins   = các ô ngăn kéo thường trú do người dùng **tự ghim/tự xóa**, tuyệt đối không tự cuộn, tuyệt đối không bị thêm/bớt thụ động vì «có xem ai đó».
// Xem bất kỳ nhân vật nào (kể cả NPC/phản diện) cũng không chiếm ô; muốn cố định thì phải chủ động gọi addPinnedChar, đầy PIN_CAP thì từ chối thêm.
// Cũng lưu ở khóa con nguyên bản 'char-pins' — không thuộc KINDS, nên thống kê dung lượng và dọn theo kind đều bỏ qua, chỉ mất khi cả sp-store bị xóa.
const CHARPINS_SUBKEY = 'char-pins';
export const PIN_CAP = 3;
export function readPinnedChars() {
    const s = store();
    if (!s) return [];
    const v = s.data[CHARPINS_SUBKEY];
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).slice(0, PIN_CAP) : [];
}
// Thêm một ô ghim. Đã có trong ô → trả về 'exists' (lũy đẳng, không thêm trùng); đã đầy → trả về 'full' (từ chối, phía gọi tự báo);
// thêm thành công vào cuối (giữ đúng thứ tự ghim, không dồn lên trước) → trả về 'ok'.
export function addPinnedChar(name) {
    const n = String(name || '').trim();
    if (!n) return 'full';
    const s = store(true);
    if (!s) return 'full';
    const prev = Array.isArray(s.data[CHARPINS_SUBKEY]) ? s.data[CHARPINS_SUBKEY].filter(x => typeof x === 'string' && x.trim()) : [];
    if (prev.includes(n)) return 'exists';
    if (prev.length >= PIN_CAP) return 'full';
    s.data[CHARPINS_SUBKEY] = [...prev, n];
    persist();
    return 'ok';
}
// Bỏ một ô ghim (lũy đẳng: không có trong ô cũng coi là thành công). Trả về có thật sự xóa gì không.
export function removePinnedChar(name) {
    const n = String(name || '').trim();
    const s = store();
    if (!s) return false;
    const prev = Array.isArray(s.data[CHARPINS_SUBKEY]) ? s.data[CHARPINS_SUBKEY] : [];
    const next = prev.filter(x => x !== n);
    if (next.length === prev.length) return false;
    s.data[CHARPINS_SUBKEY] = next;
    persist();
    return true;
}
export function isPinnedChar(name) {
    const n = String(name || '').trim();
    return !!n && readPinnedChars().includes(n);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Thống kê dung lượng / dọn dẹp (dành cho bảng quản lý lưu trữ)
// ═══════════════════════════════════════════════════════════════════════════

// Ước lượng thô số byte theo UTF-16, cùng cách tính với formatBytes của anchor/theater.
function valueBytes(v) {
    try { return (JSON.stringify(v) || '').length * 2; }
    catch { return 0; }
}

// Khóa con `{kind}-{scope}` → kind. Trong kind thì creative-chat/space-chat có dấu gạch nối, nên khớp theo tiền tố KINDS đã biết,
// và các KINDS không cái nào là tiền tố của cái nào, nên kết quả khớp là duy nhất.
function kindOfSubKey(sk) {
    return KINDS.find(k => sk === k || sk.startsWith(k + '-')) || null;
}

// Dung lượng từng kind trong chat này: { schedule, outline, lines, 'creative-chat', 'space-chat' } → số byte.
export function usageByKind() {
    const out = {};
    for (const k of KINDS) out[k] = 0;
    const s = store();
    if (!s) return out;
    for (const [sk, v] of Object.entries(s.data)) {
        const kind = kindOfSubKey(sk);
        if (!kind) continue;
        out[kind] += valueBytes(v) + sk.length * 2;
    }
    return out;
}

export function storeTotalBytes() {
    return Object.values(usageByKind()).reduce((a, b) => a + b, 0);
}

// Xóa mọi khóa con thuộc mọi scope của một kind (xóa cả góc nhìn Tôi lẫn TA). Trả về số mục đã xóa.
export function clearKind(kind) {
    const s = store();
    if (!s) return 0;
    let n = 0;
    for (const sk of Object.keys(s.data)) {
        if (sk === kind || sk.startsWith(kind + '-')) { delete s.data[sk]; n++; }
    }
    if (n) persist();
    return n;
}

// Số byte một key cấp cao của riêng Phác Họa (sp-store / sp-memory / sp-theater) đang chiếm.
export function ownKeyBytes(key) {
    const cm = getContext?.()?.chatMetadata;
    if (!cm || cm[key] == null) return 0;
    return valueBytes(cm[key]) + String(key).length * 2;
}

// Xóa nguyên một key của riêng Phác Họa (dùng cho các nút "xóa toàn bộ Điểm/Tuyến/Diện/Gian của cuộc trò chuyện này / xóa ký ức / xóa lớp vĩnh viễn của Lăng").
// Van an toàn: chỉ cho phép các key nằm trong OWN_KEYS, dữ liệu của plugin khác thì nhất loạt từ chối xóa.
export function clearOwnKey(key) {
    if (!OWN_KEYS.includes(key)) return false;
    const cm = getContext?.()?.chatMetadata;
    if (!cm || cm[key] == null) return false;
    delete cm[key];
    persist();
    return true;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Chuyển đổi một lần: localStorage(sp-cache-*) → chat_metadata['sp-store']
// ═══════════════════════════════════════════════════════════════════════════
//
// Điểm/Tuyến/Diện/Gian của người dùng cũ nằm rải rác trong localStorage (theo buildCacheKey của state.js:
//   schedule dùng khóa trần `sp-cache-{chatId}-{scope}`, còn lại là `sp-cache-{chatId}-{kind}-{scope}`,
//   scope = user | char-<enc>). Lần đầu chuyển vào một chat sẽ dời **toàn bộ scope** của chat đó sang
//   sp-store rồi xóa bản sao trong localStorage. theater-draft là bản nháp gắn với thiết bị nên bỏ qua hẳn.
//
// index.js gọi đồng bộ hàm này trong CHAT_CHANGED, **trước khi** các khung nhìn load. Giá trị trả về cho
// index.js biết chuyện gì đã xảy ra; chỉ riêng 'conflict' (đám mây và máy này mỗi bên một bản và khác nhau)
// mới cần index.js bật hộp thoại quyết định sau đó — bản thân hàm chuyển đổi tuyệt đối không bật hộp thoại, cũng tuyệt đối không đụng vào dữ liệu của bên nào khi có xung đột.

const LEGACY_PREFIX = 'sp-cache-';
// Các kind không phải schedule sẽ xuất hiện dưới dạng «đoạn tiền tố» sau khóa trần (theater-draft cũng liệt kê ra để nhận diện rồi bỏ qua).
const LEGACY_KINDS  = ['outline', 'lines', 'creative-chat', 'space-chat'];

function isValidScope(scope) {
    return scope === 'user' || scope.startsWith('char-');
}

// Phân tích phần còn lại sau `sp-cache-{chatId}-` thành { kind, scope }. Không nhận ra scope hợp lệ
// (phần lớn là khóa của plugin khác trùng tiền tố chatId) hoặc trúng theater-draft → trả về null (bỏ qua).
function parseLegacyRest(rest) {
    for (const k of LEGACY_KINDS) {
        if (rest === k || rest.startsWith(k + '-')) {
            const scope = rest.slice(k.length + 1);
            return isValidScope(scope) ? { kind: k, scope } : null;
        }
    }
    if (rest === 'theater-draft' || rest.startsWith('theater-draft-')) return null; // bản nháp của thiết bị, không chuyển
    return isValidScope(rest) ? { kind: 'schedule', scope: rest } : null;           // khóa trần = schedule
}

// Quét ra mọi khóa cũ của chat này: [{ key, subKey, value }] (value đã JSON.parse).
function scanLegacy(chatId) {
    const out = [];
    const prefix = `${LEGACY_PREFIX}${chatId}-`;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        const parsed = parseLegacyRest(key.slice(prefix.length));
        if (!parsed) continue;
        let value;
        try { value = JSON.parse(localStorage.getItem(key)); }
        catch { continue; } // hỏng → bỏ qua (vẫn để trong localStorage, không xóa nhầm)
        if (value == null) continue;
        out.push({ key, subKey: `${parsed.kind}-${parsed.scope}`, value });
    }
    return out;
}

function tsOf(v) {
    if (v && typeof v === 'object' && !Array.isArray(v) && Number.isFinite(+v.ts)) return +v.ts;
    return 0;
}

// Tập khóa con của Phác Họa ở bản cũ và trên đám mây có **giống hệt nhau** hay không (trùng tập khóa con và chuỗi JSON của từng giá trị).
function legacyEqualsCloud(legacy, cloudData) {
    const cloudKeys = Object.keys(cloudData).filter(kindOfSubKey);
    if (cloudKeys.length !== legacy.length) return false;
    for (const it of legacy) {
        if (!(it.subKey in cloudData)) return false;
        if (JSON.stringify(cloudData[it.subKey]) !== JSON.stringify(it.value)) return false;
    }
    return true;
}

// Tóm lược (cho hộp thoại xung đột): { kinds:[kind...], latestTs, count }. Nhãn tiếng Việt do index.js ánh xạ.
function summarizeData(dataMap) {
    const kinds = new Set();
    let latestTs = 0, count = 0;
    for (const [sk, v] of Object.entries(dataMap)) {
        const kind = kindOfSubKey(sk);
        if (!kind) continue;
        kinds.add(kind); count++;
        const ts = tsOf(v);
        if (ts > latestTs) latestTs = ts;
    }
    return { kinds: [...kinds], latestTs, count };
}

function summarizeLegacy(legacy) {
    const map = {};
    for (const it of legacy) map[it.subKey] = it.value;
    return summarizeData(map);
}

// Chuyển đổi chính. **Đồng bộ**, trả về:
//   { status:'none' }                            localStorage không có dữ liệu của chat này
//   { status:'migrated', count }                 đám mây trống → dời sang + xóa localStorage
//   { status:'equal', count }                    hai bên giống nhau → lặng lẽ xóa localStorage
//   { status:'conflict', legacy, cloud, local }  hai bên đều có và khác nhau → **không đụng dữ liệu**, giao index.js bật hộp thoại
export function migrateChatFromLocalStorage(chatId) {
    if (!chatId) return { status: 'none' };
    const legacy = scanLegacy(chatId);
    if (!legacy.length) return { status: 'none' };

    const s = store(true);
    if (!s) return { status: 'none' };

    const cloudHasData = Object.keys(s.data).some(kindOfSubKey);
    if (!cloudHasData) {
        for (const it of legacy) s.data[it.subKey] = it.value;
        persist();
        legacy.forEach(it => localStorage.removeItem(it.key));
        return { status: 'migrated', count: legacy.length };
    }
    if (legacyEqualsCloud(legacy, s.data)) {
        legacy.forEach(it => localStorage.removeItem(it.key));
        return { status: 'equal', count: legacy.length };
    }
    return {
        status: 'conflict',
        legacy,
        cloud: summarizeData(s.data),
        local: summarizeLegacy(legacy),
    };
}

// Quyết định khi xung đột: người dùng chọn «Giữ bản trên máy» → xóa các khóa con của Phác Họa trên đám mây, ghi bản cũ vào, xóa localStorage.
export function applyLegacyOverCloud(legacy) {
    const s = store(true);
    if (!s || !Array.isArray(legacy)) return false;
    for (const sk of Object.keys(s.data)) if (kindOfSubKey(sk)) delete s.data[sk];
    for (const it of legacy) s.data[it.subKey] = it.value;
    persist();
    legacy.forEach(it => localStorage.removeItem(it.key));
    return true;
}

// Quyết định khi xung đột: người dùng chọn «Giữ bản trên đám mây» → không đụng đám mây, chỉ bỏ bản sao trong localStorage.
export function discardLegacy(legacy) {
    if (!Array.isArray(legacy)) return;
    legacy.forEach(it => localStorage.removeItem(it.key));
}

export function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export { STORE_KEY, SCHEMA_VERSION };
