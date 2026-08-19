// anchor.js — Tọa Độ (lưu tầng tin nhắn) cho ST-SevenDaysCal
//
// Tọa Độ = nguyên tố thứ sáu trong hệ hình học của Phác Họa: Điểm (lịch trình) / Tuyến (phục bút) / Diện (đại cương) / Gian (trò chuyện ngoài lề) / Lăng (tiểu kịch trường) / Tọa Độ (lưu tầng tin nhắn).
// Định vị «dấu trang / bộ sưu tập» — lưu lại **bản chụp HTML sau khi kết xuất** của tầng tin nhắn, y nguyên, thấy sao được vậy:
//   bấm biểu tượng Tọa Độ bên cạnh tên ở tầng tin nhắn → lấy .mes_text.innerHTML đang sống (gồm cả thanh trạng thái do regex/script sinh ra tại chỗ)
//   → làm sạch (bỏ <script>/on*, giữ <style> + inline style) → lưu lên máy chủ
//   → duyệt ở khung nhìn thứ sáu theo ba lớp ngăn kéo (cuộc trò chuyện → thu nhỏ → toàn văn) → toàn văn kết xuất bằng Shadow DOM (cách ly kiểu dáng của thanh trạng thái).
//
// Lưu trữ: /api/files lõi của SillyTavern (thư mục user/files của người dùng, ghi xuống đĩa máy chủ) — một bản dùng chung,
//   đồng bộ giữa các thiết bị, đi theo tài khoản ST, xóa cache trình duyệt cũng không mất; không vào settings.json (sẽ phình to làm chậm giao diện), không vào sách thế giới.
//   Hình thái «mỗi mục một tệp»:
//     sp-anchor-{id}.json    — một bản chụp đầy đủ (gồm cả khối HTML lớn), lưu/xóa chỉ đụng một tệp, không ghi đè toàn bộ.
//     sp-anchor-index.json   — chỉ mục nhẹ (siêu dữ liệu của mọi mục, không kèm HTML); /api/files không có API liệt kê thư mục,
//                                nên dựa vào nó để lập danh sách/phân nhóm/tính dung lượng, chỉ khi mở toàn văn mới tải lẻ từng mục.
//
// Điểm mấu chốt: path do upload trả về luôn là `user/files/<name>` (backend có USER_DIRECTORY_TEMPLATE.files='user/files',
//   root='', path=clientRelativePath(root, files/name)), không phụ thuộc người dùng và chắc chắn suy ra được —
//   nên lúc khởi động nguội cứ GET theo đường dẫn suy ra là đủ, khỏi liệt kê thư mục, khỏi tải tệp thăm dò.
//
// Khác biệt then chốt so với Lăng: Lăng lột bỏ <style> (bắt buộc inline), còn Tọa Độ **giữ lại <style>** (thanh trạng thái dựa vào nó),
// và cách ly kiểu dáng bằng Shadow DOM thay vì lột bỏ. Việc làm sạch chỉ nhằm bảo mật (bỏ script/sự kiện), không đụng tới bố cục.

import { getContext } from '../../../extensions.js';

const FILES_DIR       = 'user/files';           // backend cố định; tiền tố của path do upload trả về
const INDEX_NAME      = 'sp-anchor-index.json';
const FILE_PREFIX     = 'sp-anchor-';           // một mục: sp-anchor-{id}.json
const SIZE_WARN_BYTES = 8 * 1024 * 1024;        // ước tính vượt ngưỡng này thì nhắc dọn dẹp (bản chụp mang theo kiểu dáng nên khá lớn, chừa dư dả)

// ─── Tiêm phụ thuộc (initAnchor) ─────────────────────────────────────────────
let _getSettings = () => ({});

// ═══════════════════════════════════════════════════════════════════════════
//  Bọc /api/files
// ═══════════════════════════════════════════════════════════════════════════
//
// upload: POST /api/files/upload {name, data(base64)} → {path}; write-file-atomic ghi đè khi trùng tên.
// Đọc:    GET `user/files/<name>` → văn bản (404 = không tồn tại). delete: POST /api/files/delete {path}.
// Tên tệp chỉ cho phép [a-zA-Z0-9_\-.] (backend validateAssetFileName).

function headers() {
    const h = getContext?.()?.getRequestHeaders?.();
    return h || { 'Content-Type': 'application/json' };
}

// path luôn suy ra được, khỏi cần cache giá trị upload trả về.
function pathOf(name) { return `${FILES_DIR}/${name}`; }

function fileNameOf(id) {
    return `${FILE_PREFIX}${String(id).replace(/[^a-zA-Z0-9_\-.]/g, '')}.json`;
}

// base64 an toàn UTF-8 (btoa chỉ ăn latin1, bản chụp có tiếng Việt/tiếng Trung sẽ vỡ — nên qua TextEncoder rồi chuyển theo từng khối).
function toBase64(str) {
    const utf8 = new TextEncoder().encode(String(str ?? ''));
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < utf8.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, utf8.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

async function uploadJson(name, obj) {
    const res = await fetch('/api/files/upload', {
        method : 'POST',
        headers: headers(),
        body   : JSON.stringify({ name, data: toBase64(JSON.stringify(obj)) }),
    });
    if (!res.ok) throw new Error(`upload ${name}: ${res.status} ${await res.text().catch(() => '')}`);
    const out = await res.json();
    return out.path;
}

async function readJson(name) {
    const res = await fetch(pathOf(name), { method: 'GET', cache: 'no-cache', headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`read ${name}: ${res.status}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return null; }
}

async function deleteFile(name) {
    const res = await fetch('/api/files/delete', {
        method : 'POST',
        headers: headers(),
        body   : JSON.stringify({ path: pathOf(name) }),
    });
    if (!res.ok && res.status !== 404) throw new Error(`delete ${name}: ${res.status}`);
}
// ═══════════════════════════════════════════════════════════════════════════
//  Chỉ mục (sp-anchor-index.json): { version, items:[ meta... ], tags:[ {id,name,color}... ] }
//  meta = { id, chatId, chatIdHash, chatName, charName, messageId, floorIndex, textPreview, ts, bytes, tags }
//  — không kèm html; html nằm trong từng sp-anchor-{id}.json. bytes = số byte ước tính của bản chụp đầy đủ của mục đó.
//  tags = mảng id nhãn đã gắn cho mục (bảng đăng ký nằm ở idx.tags, item chỉ lưu id, khi phân tích thì tra bảng đăng ký theo id).
// ═══════════════════════════════════════════════════════════════════════════

let _indexCache   = null;    // chỉ mục trong bộ nhớ { version, items:[] }
let _indexPromise = null;    // promise in-flight khi đọc chỉ mục lúc khởi động nguội (chống tải trùng do gọi song song)

async function loadIndex(force = false) {
    if (_indexCache && !force) return _indexCache;
    if (_indexPromise && !force) return _indexPromise;
    _indexPromise = (async () => {
        let idx = await readJson(INDEX_NAME).catch(() => null);
        if (!idx || typeof idx !== 'object' || !Array.isArray(idx.items)) {
            idx = { version: 1, items: [] };
        }
        if (!Array.isArray(idx.tags)) idx.tags = [];   // bảng đăng ký nhãn: chỉ mục cũ không có trường này → chuẩn hóa thành rỗng
        _indexCache = idx;
        return idx;
    })();
    try { return await _indexPromise; }
    finally { _indexPromise = null; }
}

async function saveIndex() {
    if (!_indexCache) return;
    await uploadJson(INDEX_NAME, _indexCache);
}

// Ước tính số byte của một bản ghi đầy đủ (theo UTF-16, cùng cách tính với formatBytes của store/theater). html chiếm phần lớn.
function itemBytes(it) {
    let n = 0;
    for (const k in it) {
        const v = it[k];
        n += (k.length + String(v == null ? '' : v).length) * 2;
    }
    return n;
}

// item đầy đủ → meta trong chỉ mục (lột bỏ html, giữ siêu dữ liệu + bytes để lập danh sách/tính dung lượng).
function toMeta(item) {
    return {
        id        : item.id,
        chatId    : item.chatId ?? null,
        chatIdHash: item.chatIdHash ?? null,
        chatName  : item.chatName || '',
        charName  : item.charName || '',
        messageId : item.messageId ?? null,
        floorIndex: item.floorIndex ?? null,
        textPreview: item.textPreview || '',
        ts        : item.ts || 0,
        bytes     : itemBytes(item),
        tags      : Array.isArray(item.tags) ? item.tags : [],
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  CRUD (API chính đối ngoại, chữ ký giữ nguyên như bản IndexedDB cũ, index.js không phải sửa)
// ═══════════════════════════════════════════════════════════════════════════

export async function addItem(item) {
    // ghi một mục xuống đĩa
    await uploadJson(fileNameOf(item.id), item);
    // cập nhật chỉ mục (trùng id thì ghi đè)
    const idx = await loadIndex();
    const meta = toMeta(item);
    const i = idx.items.findIndex(m => m.id === item.id);
    if (i >= 0) idx.items[i] = meta; else idx.items.push(meta);
    await saveIndex();
    return item;
}

export async function getItem(id) {
    if (!id) return null;
    return readJson(fileNameOf(id)).catch(() => null);
}

// Chỉ mục chỉ có meta; getAllItems ghép «meta + html rỗng» rồi trả về, đủ dùng cho danh sách/phân nhóm/dung lượng.
// Chỗ nào cần html (khung nhìn toàn văn) thì gọi getItem để tải lẻ từng mục theo nhu cầu.
export async function getAllItems() {
    const idx = await loadIndex();
    return idx.items.map(m => ({ ...m, html: '' }));
}

export async function deleteItem(id) {
    if (!id) return;
    await deleteFile(fileNameOf(id)).catch(() => {});   // xóa một mục có thất bại cũng vẫn dọn chỉ mục, tránh sót rác
    const idx = await loadIndex();
    const before = idx.items.length;
    idx.items = idx.items.filter(m => m.id !== id);
    if (idx.items.length !== before) await saveIndex();
}

export async function countItems() {
    const idx = await loadIndex();
    return idx.items.length;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Nhãn (bảng đăng ký toàn cục idx.tags = [{ id, name, color }])
// ═══════════════════════════════════════════════════════════════════════════
//
// Nhãn dùng chung toàn cục: định nghĩa một lần, mọi nhân vật/cuộc trò chuyện đều gắn và lọc được. Bảng đăng ký gắn trên tệp chỉ mục (idx.tags),
// item chỉ lưu mảng id nhãn (item.tags) — renameTag/recolorTag chỉ sửa bảng đăng ký, không ghi lại item;
// chỉ deleteTag mới cần quét mọi item để bóc id đó ra (theo đúng mô thức «sửa chỉ mục + làm mới từng tệp lẻ» của renameChatId).
// color lưu key của bảng màu (rose/amber/…), màu thật do style.css định nghĩa theo [data-color] (tự hợp cả chế độ ngày/đêm).

export async function getTags() {
    const idx = await loadIndex();
    return Array.isArray(idx.tags) ? idx.tags : [];
}

// Tạo nhãn mới (khử trùng theo tên: đã có thì trả về nguyên trạng, không tạo lại). Trả về tag đó.
export async function addTag(name, color) {
    const nm = String(name || '').trim();
    if (!nm) return null;
    const idx = await loadIndex();
    if (!Array.isArray(idx.tags)) idx.tags = [];
    const exist = idx.tags.find(t => t.name === nm);
    if (exist) return exist;
    const tag = {
        id   : (crypto?.randomUUID?.() || `t-${Date.now()}-${Math.floor(performance.now())}`),
        name : nm,
        color: String(color || ''),
    };
    idx.tags.push(tag);
    await saveIndex();
    return tag;
}

// Đổi tên / đổi màu: chỉ sửa một chỗ trong bảng đăng ký, item không đụng tới (item lưu id).
export async function renameTag(id, name) {
    const nm = String(name || '').trim();
    if (!id || !nm) return;
    const idx = await loadIndex();
    const t = (idx.tags || []).find(x => x.id === id);
    if (t && t.name !== nm) { t.name = nm; await saveIndex(); }
}

export async function recolorTag(id, color) {
    if (!id) return;
    const idx = await loadIndex();
    const t = (idx.tags || []).find(x => x.id === id);
    if (t) { t.color = String(color || ''); await saveIndex(); }
}

// Xóa nhãn: xóa khỏi bảng đăng ký; rồi quét mọi item.tags để bỏ id đó ra (sửa meta trong chỉ mục một lượt + làm mới từng tệp lẻ).
// Trả về số mục bị ảnh hưởng. Đây là thao tác phá hủy trên phạm vi toàn cục, phía gọi nên hỏi xác nhận trước.
export async function deleteTag(id) {
    if (!id) return 0;
    const idx = await loadIndex();
    if (Array.isArray(idx.tags)) idx.tags = idx.tags.filter(t => t.id !== id);
    const affected = (idx.items || []).filter(m => Array.isArray(m.tags) && m.tags.includes(id));
    for (const m of affected) m.tags = m.tags.filter(x => x !== id);
    await saveIndex();
    for (const m of affected) {
        try {
            const item = await getItem(m.id);
            if (!item) continue;
            item.tags = Array.isArray(item.tags) ? item.tags.filter(x => x !== id) : [];
            await uploadJson(fileNameOf(item.id), item);
        } catch (err) { console.warn('[SP anchor] Xóa nhãn: đồng bộ mục lẻ thất bại:', m.id, err); }
    }
    return affected.length;
}

// Đặt mảng id nhãn cho một mục đã lưu (addItem tải lại tệp lẻ + qua toMeta làm mới meta trong chỉ mục, gồm cả tags mới).
export async function setItemTags(id, tagIds) {
    const it = await getItem(id);
    if (!it) return;
    it.tags = Array.isArray(tagIds) ? [...tagIds] : [];
    await addItem(it);
}

// Tìm mọi id đã lưu của một tầng (cùng một tầng có thể có nhiều mục, khi bỏ lưu phải xóa hết). messageId và floorIndex cùng giá trị, khớp một trong hai là được.
export async function findItemIdsByFloor(chatId, floorIndex) {
    const idx = await loadIndex();
    const cid = String(chatId);
    const fi  = +floorIndex;
    if (!Number.isFinite(fi)) return [];
    return (idx.items || [])
        .filter(m => String(m.chatId) === cid && (Number(m.messageId) === fi || Number(m.floorIndex) === fi))
        .map(m => m.id);
}

// Sau khi cuộc trò chuyện được đổi tên (SillyTavern đổi tên tệp chat = chatId thay đổi), dời những bản ghi có chatId===oldId
// trong chỉ mục và trong các tệp lẻ sang newId, đồng thời đồng bộ chatName thành tên mới (tên cuộc trò chuyện của ST chính là tên tệp).
// index.js gọi hàm này qua sự kiện CHAT_RENAMED.
// Chỉ mục sửa một lượt rồi lưu một lần; tệp lẻ thì getItem→sửa→addItem từng cái (đổi tên không thường xuyên, số mục đã lưu thường có hạn, chấp nhận được).
// Không đưa newName thì lấy newId làm tên hiển thị. Trả về số mục đã dời.
export async function renameChatId(oldId, newId, newName = '', chatIdHash = null) {
    if (oldId == null || newId == null) return 0;
    const oId = String(oldId), nId = String(newId);
    if (oId === nId) return 0;
    const idx = await loadIndex();
    const hit = idx.items.filter(m => String(m.chatId) === oId);
    if (!hit.length) return 0;
    const nName = String(newName || nId);
    // chat_id_hash không đổi khi đổi tên: nếu có thì tiện tay bổ sung vào từng mục (dữ liệu cũ chưa từng lưu hash sẽ được điền bù),
    // từ đó việc phân nhóm/tự chữa có khóa ổn định, không còn bị chatId trôi dạt làm ảnh hưởng.
    const stampHash = (chatIdHash != null && chatIdHash !== '') ? chatIdHash : null;
    for (const m of hit) { m.chatId = nId; m.chatName = nName; if (stampHash != null && m.chatIdHash == null) m.chatIdHash = stampHash; }
    await saveIndex();
    // Đồng bộ tệp lẻ (việc nhảy tới nguồn đối chiếu chatId nằm trong tệp lẻ, phải sửa cùng lúc, nếu không sẽ nhảy hụt)
    for (const m of hit) {
        try {
            const item = await getItem(m.id);
            if (!item) continue;
            item.chatId = nId;
            item.chatName = nName;
            if (stampHash != null && item.chatIdHash == null) item.chatIdHash = stampHash;
            await uploadJson(fileNameOf(item.id), item);
        } catch (err) { console.warn('[SP anchor] Đổi tên: đồng bộ mục lẻ thất bại:', m.id, err); }
    }
    return hit.length;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Tự chữa: theo chat_id_hash tìm lại những mục đã lưu bị sót khi đổi tên
// ═══════════════════════════════════════════════════════════════════════════
//
// renameChatId chạy nhờ sự kiện CHAT_RENAMED — nếu ngay lúc đổi tên plugin chưa nạp, hoặc bảng điều khiển đóng/mở liên tục làm lỡ mất sự kiện,
// thì sẽ sót: mục đã lưu vẫn giữ chatId cũ, nhảy tới thì hụt, tên nhóm không theo tên mới. chat_id_hash là khóa ổn định **không đổi khi đổi tên**
// (lần đầu ST dùng macro kiểu {{chatid}} thì getStringHash(tên tệp gốc) được tính một lần và cache vĩnh viễn vào chat_metadata,
// đổi tên không tính lại), nhờ đó tra ngược được "những mục đã lưu nào thật ra chính là chat hiện tại ở dạng trước khi đổi tên" rồi dời về chat hiện tại.
// index.js gọi trong CHAT_CHANGED, để đỡ cho những trường hợp CHAT_RENAMED lọt lưới.

// getStringHash (cyrb53): ưu tiên dùng bản cài đặt ST phơi ra qua context, để giống hệt thuật toán lõi tới từng byte;
// bản cũ không phơi ra thì lùi về bản nội tuyến (tương đương public/scripts/utils.js:getStringHash, seed cố định 0).
function strHash(input) {
    const s = String(input ?? '');
    const fn = getContext?.()?.getStringHash;
    if (typeof fn === 'function') return fn(s);
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0, ch; i < s.length; i++) {
        ch = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// currentChatId/currentChatName = cuộc trò chuyện hiện tại; chatIdHash = chat_metadata.chat_id_hash.
// Tìm ra những mục đã lưu "thật ra chính là bản thân chat hiện tại trước khi đổi tên", dời về chatId hiện tại, tiện thể điền bù khóa hash ổn định.
// Hai manh mối để kết luận mục thuộc chat hiện tại (thỏa một trong hai là được):
//   (a) chatIdHash đã lưu === hash hiện tại — đáng tin nhất, đổi tên bao nhiêu lần cũng nhận ra (dữ liệu mới đi đường này);
//   (b) dữ liệu cũ chưa lưu hash: lùi về strHash(m.chatId) === hash hiện tại (chỉ trúng khi chatId vẫn là tên gốc,
//       đổi tên nhiều cấp thì có thể sót, nhưng đã có (a) đỡ, mục lưu mới chỉ cần một lần là bù đủ).
// Mục nào trúng nhưng chatId đã đúng giá trị hiện tại thì cũng phải điền bù hash (gộp lại những nhóm bị tách ra do đổi tên). Trả về số mục thật sự đã dời.
export async function healChatByHash(currentChatId, currentChatName, chatIdHash) {
    const wantHash = Number(chatIdHash);
    if (!currentChatId || !Number.isFinite(wantHash)) return 0;
    const idx = await loadIndex();
    const cur = String(currentChatId);

    // Mọi item thuộc chat hiện tại (thỏa một trong ba là được), bất kể chatId đã đúng hay chưa:
    //   (a) hash đã lưu trùng khớp; (b) dữ liệu cũ hash trống, strHash(chatId) trùng khớp; (c) chatId đúng là chat hiện tại.
    // (c) đỡ cho trường hợp "chat_id_hash trong metadata được tính từ một cái tên nào đó ở giữa quá trình đổi tên, không khớp hash của tên gốc" —
    //     khi đó các mục đã lưu của chính chat hiện tại có thể không trúng (a)(b), nhưng chatId===giá trị hiện tại thì chắc chắn thuộc về nó, cứ nhận và bù hash.
    const mine = idx.items.filter(m =>
        (m.chatIdHash != null && Number(m.chatIdHash) === wantHash) ||
        ((m.chatIdHash == null || m.chatIdHash === '') && strHash(m.chatId) === wantHash) ||
        String(m.chatId) === cur
    );
    if (!mine.length) return 0;

    // ① Điền bù khóa hash ổn định (gồm cả những mục chatId vốn đã đúng, chỉ thiếu hash — chính chúng gây ra việc nhóm bị tách)
    let backfilled = 0;
    for (const m of mine) {
        if (m.chatIdHash == null || m.chatIdHash === '') { m.chatIdHash = wantHash; backfilled++; }
    }

    // ② Dời những mục lưu cũ có chatId đã trôi dạt về giá trị hiện tại
    const staleIds = [...new Set(mine.filter(m => String(m.chatId) !== cur).map(m => m.chatId))];
    let migrated = 0;
    if (staleIds.length) {
        await saveIndex();   // ghi phần điền bù xuống đĩa trước, vì renameChatId bên trong sẽ đọc lại chỉ mục
        for (const oldId of staleIds) {
            try { migrated += await renameChatId(oldId, currentChatId, currentChatName, wantHash); }
            catch (err) { console.warn('[SP anchor] Tự chữa: dời thất bại:', oldId, err); }
        }
    } else if (backfilled) {
        await saveIndex();
        // Tệp lẻ cũng bù hash (giống chỉ mục; số lượng thường rất nhỏ)
        for (const m of mine) {
            try {
                const item = await getItem(m.id);
                if (item && (item.chatIdHash == null || item.chatIdHash === '')) {
                    item.chatIdHash = wantHash;
                    await uploadJson(fileNameOf(item.id), item);
                }
            } catch (err) { console.warn('[SP anchor] Điền bù hash cho mục lẻ thất bại:', m.id, err); }
        }
    }
    // Giá trị trả về chỉ mang ý nghĩa tín hiệu đúng/sai «có thay đổi gì không» (phía gọi là index.js chỉ dùng if(n>0) để quyết định có làm mới bảng hay không).
    // Nên cứ cộng thẳng: việc dời và việc điền bù có thể trúng cùng một mục (đếm trùng cũng vô hại), điều quan trọng là đừng để trường hợp «dời thì no-op nhưng có điền bù» bị quy về 0 mà bỏ sót lần làm mới.
    const total = migrated + backfilled;
    if (migrated || backfilled) console.info(`[SP anchor] Tự chữa: đã dời ${migrated} mục, điền bù hash ${backfilled} mục → ${currentChatId}`);
    return total;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Nhận nuôi mục mồ côi: những mục lưu cũ bị đứt chuỗi hash, nhận theo tiêu chí "cùng nhân vật + tên cũ không còn tồn tại + nhân vật đó chỉ có đúng một cuộc trò chuyện"
// ═══════════════════════════════════════════════════════════════════════════
//
// chat_id_hash là hash của **tên tệp gốc**; nếu mục được lưu sau khi đã đổi tên thì chatId lưu lại là một cái tên trung gian,
// truy theo hash sẽ không bao giờ tìm lại được (hash(tên trung gian) ≠ hash(tên gốc)). Bằng chứng quy thuộc đáng tin duy nhất cho loại mồ côi này:
//   ① charName trùng với nhân vật hiện tại; ② chatId nó mang đã không còn trong các tệp chat hiện có của nhân vật đó (= đã bị đổi tên đi mất);
//   ③ nhân vật đó hiện chỉ có đúng cuộc trò chuyện này (không mơ hồ, không gộp nhầm).
// Phải thỏa cả ba mới nhận về và bù hash; nhân vật có nhiều cuộc trò chuyện thì thà không đụng, tránh gộp nhầm.
export async function adoptOrphans(charName, existingChatIds, currentChatId, currentChatName, chatIdHash = null) {
    if (!charName || !currentChatId) return 0;
    const cur = String(currentChatId);
    const idx = await loadIndex();
    const stale = [...new Set(
        idx.items
            .filter(m => (m.charName || '') === charName
                && String(m.chatId) !== cur
                && !existingChatIds.has(String(m.chatId)))
            .map(m => m.chatId)
    )];
    if (!stale.length) return 0;
    let total = 0;
    for (const oldId of stale) {
        try { total += await renameChatId(oldId, currentChatId, currentChatName, chatIdHash); }
        catch (err) { console.warn('[SP anchor] Nhận nuôi mục mồ côi thất bại:', oldId, err); }
    }
    if (total) console.info(`[SP anchor] Đã nhận nuôi ${total} mục lưu mồ côi theo nhân vật → ${currentChatId}`);
    return total;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Phân nhóm: gom theo cuộc trò chuyện nguồn (dẫn xuất lúc đọc, không lưu thư mục riêng)
// ═══════════════════════════════════════════════════════════════════════════

// Trả về [{ chatId, chatName, charName, count, latestTs, items:[] }], sắp xếp theo lần lưu gần nhất giảm dần.
// items là meta (không kèm html); khi mở toàn văn mới gọi getItem để tải nội dung.
export async function listByChat() {
    const items = await getAllItems();
    const buckets = new Map();
    for (const it of items) {
        // Khóa phân nhóm ưu tiên dùng chat_id_hash (khóa ổn định, đổi tên không đổi) — cùng một cuộc trò chuyện dù chatId
        // có trôi thành mấy giá trị khác nhau vì đổi tên/sót đồng bộ, chỉ cần hash giống nhau là gộp về cùng một nhóm,
        // tránh chuyện "đổi tên xong bị tách ra nhiều nhóm mục đã lưu". Dữ liệu cũ chưa lưu hash → lùi về phân nhóm theo chatId (giữ hành vi cũ).
        const key = (it.chatIdHash != null && it.chatIdHash !== '')
            ? `h:${it.chatIdHash}`
            : `c:${it.chatId || '(unknown)'}`;
        if (!buckets.has(key)) {
            buckets.set(key, {
                chatId  : it.chatId,
                chatIdHash: it.chatIdHash ?? null,
                chatName: it.chatName || '(Cuộc trò chuyện chưa đặt tên)',
                charName: it.charName || '',
                items   : [],
                latestTs: 0,
            });
        }
        const b = buckets.get(key);
        b.items.push(it);
        if (it.ts > b.latestTs) b.latestTs = it.ts;
        // Tên hiển thị & chatId đại diện của nhóm lấy theo mục mới nhất (cuộc trò chuyện có thể đã đổi tên, tên/id của mục mới nhất là chuẩn nhất)
        if (it.ts === b.latestTs) {
            b.chatName = it.chatName || b.chatName;
            b.charName = it.charName || b.charName;
            b.chatId   = it.chatId ?? b.chatId;
        }
    }
    const out = [...buckets.values()];
    for (const b of out) {
        b.items.sort((a, z) => (z.floorIndex ?? 0) - (a.floorIndex ?? 0) || z.ts - a.ts);
        b.count = b.items.length;
    }
    out.sort((a, z) => z.latestTs - a.latestTs);
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Làm sạch bản chụp + xem trước
// ═══════════════════════════════════════════════════════════════════════════
//
// Ngược với Lăng: **giữ lại <style> và inline style** (thanh trạng thái dựa vào chúng để hiển thị), chỉ bỏ <script>/on*/giao thức nguy hiểm.
// DOMPurify mặc định đã bỏ <script>/on*/javascript:, và mặc định giữ lại <style> cùng thuộc tính style — đúng thứ cần.
// Vấn đề rò rỉ kiểu dáng không giải quyết ở đây mà giao cho việc cách ly bằng Shadow DOM ở phía kết xuất.

export function sanitizeSnapshot(htmlRaw) {
    const html = String(htmlRaw || '');
    const purifier = globalThis.DOMPurify;
    if (purifier && typeof purifier.sanitize === 'function') {
        const clean = purifier.sanitize(html, {
            ADD_TAGS: ['style'],
            ALLOW_DATA_ATTR: true,
            RETURN_TRUSTED_TYPE: false,
        });
        return stripRenderBoxes(clean);
    }
    console.warn('[SP anchor] DOMPurify không dùng được, lùi về bản chụp văn bản thuần');
    const div = document.createElement('div');
    div.textContent = html;
    return div.innerHTML;
}

// Bóc khỏi bản chụp những «khung kết xuất» không nên giữ:
//   .TH-render / iframe — khung động do TavernHelper kết xuất tại chỗ bằng <iframe srcdoc>, không đóng băng thành bản chụp tĩnh được;
//   .sp-inline-box      — khung Điểm/Lịch/phần gọi lại mà Phác Họa chèn vào tầng tin nhắn (dùng chung vỏ `.sp-inline-box`), thuần là UI của plugin chứ không phải nội dung chính, bóc cả khối;
//   .sp-lines-inline    — khối «Tuyến» nội tuyến mà Phác Họa chèn vào tầng tin nhắn (phần hiển thị phục bút, mẩu kiến thức vui đường đứt cũng gấp trong body của nó),
//                          thuần là UI của plugin chứ không phải nội dung chính, bóc cả khối thì mẩu kiến thức vui cũng đi theo;
//   .sp-dashed-inline   — phần đỡ cho khối đường đứt độc lập ở bản cũ trước khi gộp, quét sạch DOM còn sót lại.
function stripRenderBoxes(htmlStr) {
    const div = document.createElement('div');
    div.innerHTML = String(htmlStr || '');
    div.querySelectorAll('.TH-render, iframe, .sp-inline-box, .sp-lines-inline, .sp-dashed-inline').forEach(el => el.remove());
    return div.innerHTML;
}

// Rút bản xem trước dạng văn bản thuần từ bản chụp (đã làm sạch): trước hết loại <style>/<script> để khỏi tưởng mã CSS là nội dung,
// rồi lấy textContent, nén khoảng trắng, cắt bớt. Lưu vào item.textPreview để dùng cho cửa sổ thu nhỏ và tìm kiếm.
export function makePreview(htmlSnapshot, max = 140) {
    const div = document.createElement('div');
    div.innerHTML = String(htmlSnapshot || '');
    div.querySelectorAll('style, script').forEach(el => el.remove());
    const text = (div.textContent || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max) + '…' : text;
}
// ═══════════════════════════════════════════════════════════════════════════
//  Ước tính dung lượng / nhắc nhở sức chứa
// ═══════════════════════════════════════════════════════════════════════════
//
// Tổng hợp từ meta.bytes trong chỉ mục — khỏi phải tải toàn bộ HTML bản chụp về (lợi thế của kiểu mỗi mục một tệp + chỉ mục nhẹ).

export async function estimateBytes() {
    const idx = await loadIndex();
    return idx.items.reduce((sum, m) => sum + (Number(m.bytes) || 0), 0);
}

export function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export async function checkSize() {
    const warnAt = Number(_getSettings().anchorSizeWarnBytes) || SIZE_WARN_BYTES;
    const bytes = await estimateBytes();
    return { over: bytes > warnAt, bytes, warnAt };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Lưu một tầng tin nhắn: index.js lấy sẵn rawInnerHtml + siêu dữ liệu rồi truyền vào, ở đây làm sạch + lắp ráp + ghi vào kho
// ═══════════════════════════════════════════════════════════════════════════
//
// meta: { chatId, chatIdHash, chatName, charName, messageId, floorIndex }
// rawInnerHtml: innerHTML đang sống của .mes_text ở tầng đó (sau khi kết xuất, gồm cả thanh trạng thái do script sinh ra)

export async function saveSnapshot(meta, rawInnerHtml) {
    const html = sanitizeSnapshot(rawInnerHtml);
    const item = {
        id        : (crypto?.randomUUID?.() || `a-${Date.now()}-${Math.floor(performance.now())}`),
        chatId    : meta?.chatId ?? getContext().chatId ?? null,
        chatIdHash: meta?.chatIdHash ?? getContext()?.chatMetadata?.chat_id_hash ?? null,
        chatName  : meta?.chatName || '',
        charName  : meta?.charName || '',
        messageId : meta?.messageId ?? null,
        floorIndex: Number.isFinite(+meta?.floorIndex) ? +meta.floorIndex : null,
        html,
        textPreview: makePreview(html),
        ts        : Date.now(),
        tags      : [],
    };
    await addItem(item);
    return item;
}

// ═══════════════════════════════════════════════════════════════════════════
//  init
// ═══════════════════════════════════════════════════════════════════════════

export function initAnchor({ getSettings } = {}) {
    if (getSettings) _getSettings = getSettings;
    // Làm nóng chỉ mục (một lượt GET, để lúc khởi động nguội không phải đợi tới lần lưu đầu tiên mới tải); thành công thì chạy đợt chuyển đổi một lần IndexedDB→/api/files.
    // Thất bại thì im lặng — khi thao tác thật sẽ thử lại.
    loadIndex()
        .then(() => migrateFromIndexedDB())
        .catch(err => console.warn('[SP anchor] Khởi tạo thất bại:', err));
}

// ═══════════════════════════════════════════════════════════════════════════
//  Chuyển đổi một lần: IndexedDB bản cũ (DB 'sp-anchor') → /api/files
// ═══════════════════════════════════════════════════════════════════════════
//
// Trước 2.0.0, Tọa Độ lưu trong IndexedDB của trình duyệt. Sau khi nâng cấp thì chuyển sang lưu ở máy chủ, nên mục đã lưu của người dùng cũ phải dời sang, nếu không sẽ biến mất.
// Chiến lược: dò kho cũ → dời từng mục vào /api/files (trùng id thì ghi đè, chạy lại vẫn lũy đẳng) → tất cả thành công mới xóa kho cũ.
// Dựa vào "kho cũ có tồn tại và không rỗng hay không" để kích hoạt, khỏi cần cờ đánh dấu: dời xong là xóa kho, lần dò sau thấy rỗng thì tự bỏ qua.

const LEGACY_DB = 'sp-anchor';
const LEGACY_STORE = 'items';

function openLegacyDb() {
    return new Promise((resolve) => {
        let req;
        try { req = indexedDB.open(LEGACY_DB); }          // không kèm version: chỉ mở kho đã tồn tại, không nâng cấp
        catch { resolve(null); return; }
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => resolve(null);
        req.onupgradeneeded = () => { /* kho vốn không tồn tại, cứ để nó tạo vỏ rỗng, sau đó xử lý như không có store */ };
    });
}

function readAllLegacy(db) {
    return new Promise((resolve) => {
        if (!db.objectStoreNames.contains(LEGACY_STORE)) { resolve([]); return; }
        try {
            const r = db.transaction(LEGACY_STORE, 'readonly').objectStore(LEGACY_STORE).getAll();
            r.onsuccess = () => resolve(Array.isArray(r.result) ? r.result : []);
            r.onerror   = () => resolve([]);
        } catch { resolve([]); }
    });
}

async function migrateFromIndexedDB() {
    if (typeof indexedDB === 'undefined') return;
    const db = await openLegacyDb();
    if (!db) return;
    let legacy = [];
    try { legacy = await readAllLegacy(db); } finally { db.close(); }
    if (!legacy.length) { dropLegacyDb(); return; }        // kho rỗng thì xóa luôn, dọn vỏ cũ còn sót

    console.info(`[SP anchor] Phát hiện ${legacy.length} mục lưu cũ, đang dời sang máy chủ…`);
    let ok = 0;
    for (const item of legacy) {
        if (!item || !item.id) continue;
        try { await addItem(item); ok++; }                 // addItem lũy đẳng: trùng id thì ghi đè + cập nhật chỉ mục
        catch (err) { console.warn('[SP anchor] Dời một mục thất bại, giữ lại kho cũ:', item.id, err); return; }
    }
    console.info(`[SP anchor] Dời xong ${ok}/${legacy.length}, xóa IndexedDB cũ`);
    dropLegacyDb();
}

function dropLegacyDb() {
    try { indexedDB.deleteDatabase(LEGACY_DB); } catch { /* xóa không được cũng không chết ai, lần sau kho rỗng thì thử lại */ }
}

export { INDEX_NAME, FILE_PREFIX, SIZE_WARN_BYTES };



