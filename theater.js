// theater.js — Lăng (tiểu kịch trường) cho ST-SevenDaysCal
//
// Lăng = nguyên tố thứ năm trong hệ hình học của Phác Họa: Điểm (lịch trình) / Tuyến (phục bút) / Diện (đại cương) / Gian (trò chuyện ngoài lề) / Lăng (tiểu kịch trường).
// Định vị «tuyến giả định / ngoại truyện / khả năng khác» — bộ tạo tiểu kịch trường một lượt, hỏi một câu đáp một bài:
//   người dùng điền bối cảnh + số chữ → agent viết văn cho ra văn bản (raw) → agent làm đẹp cho ra HTML → DOMPurify kết xuất
//   → có thể tạo lại / sửa đầu vào → ưng ý thì điền tiêu đề, gắn nhãn → lưu bản nháp (localStorage) / nâng lên vĩnh viễn (chat_metadata).
//
// Ba lớp lưu trữ:
//   · Lớp bản nháp   localStorage, theo từng chat, cửa sổ trượt (THEATER_DRAFT_CAP)
//   · Lớp vĩnh viễn  chat_metadata['sp-theater'], đi kèm file chat
//   · Kho mẫu        sách thế giới chuyên dụng TEMPLATE_BOOK (toàn cục, JSON riêng, không vào settings.json, tuyệt đối không đưa vào AI)
//
// Tiêm phụ thuộc (initTheater): getSettings / callWriteApi / callBeautifyApi / getStoryContext.
// CRUD sách thế giới và chat_metadata gọi thẳng getContext(), giống hệt memory.js.

import { getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';
import { buildTheaterDraftKey } from './state.js';

const THEATER_KEY   = 'sp-theater';     // key lớp vĩnh viễn trong chat_metadata
const SCHEMA_VERSION = 1;
const THEATER_DRAFT_CAP = 10;           // giới hạn cửa sổ trượt của bản nháp
const TEMPLATE_BOOK = 'PhacHoa-Lang-Mau-Tieu-Kich-Truong';   // tên sách thế giới chuyên dụng (đặt bằng gạch ngang, không dấu, để tránh bị sanitize tên tệp)

// ─── Tiêm phụ thuộc ──────────────────────────────────────────────────────────
let _getSettings = () => ({
    theaterStylePrompt   : '',
    theaterBeautifyPrompt: '',
});
let _callWriteApi    = null;   // (messages, {maxTokens, signal}) => Promise<string>
let _callBeautifyApi = null;   // (messages, {maxTokens, signal}) => Promise<string>
let _getStoryContext = null;   // () => { sysBlocks:[], userName, charName }

// ─── Trạng thái tạo (để index.js truy vấn in-flight) ─────────────────────────
let _generating = false;
export function isTheaterGenerating() { return _generating; }
// Đặt lại đồng bộ khi người dùng hủy: tín hiệu abort truyền tới fetch → chuỗi promise được gỡ → việc đặt lại trong finally là bất đồng bộ,
// nếu giữa chừng người dùng bấm tạo lại ngay thì bộ canh sẽ báo nhầm "đang tạo". Cung cấp lối vào đồng bộ để index.js xóa cờ ngay khi hủy.
export function resetTheaterGenerating() { _generating = false; }

// ═══════════════════════════════════════════════════════════════════════════
//  Lớp bản nháp (localStorage, theo từng chat)
// ═══════════════════════════════════════════════════════════════════════════

function draftKey() {
    const chatId = getContext().chatId;
    return buildTheaterDraftKey(chatId);
}

export function loadDrafts() {
    const key = draftKey();
    if (!key) return [];
    try {
        const arr = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(arr) ? arr.filter(p => p && p.id) : [];
    } catch { return []; }
}

function saveDrafts(list) {
    const key = draftKey();
    if (!key) return;
    // Cửa sổ trượt: cái mới đẩy cái cũ ra, chỉ giữ CAP mục gần nhất
    const trimmed = list.slice(-THEATER_DRAFT_CAP);
    try { localStorage.setItem(key, JSON.stringify(trimmed)); }
    catch (err) { console.warn('[SP theater] Ghi bản nháp thất bại (có thể vượt hạn mức):', err); }
}

// Tự lưu bản nháp sau khi tạo (cửa sổ trượt)
function pushDraft(piece) {
    const list = loadDrafts();
    list.push(piece);
    saveDrafts(list);
}

export function deleteDraft(id) {
    saveDrafts(loadDrafts().filter(p => p.id !== id));
}

// ═══════════════════════════════════════════════════════════════════════════
//  Lớp vĩnh viễn (chat_metadata['sp-theater']) — chép y meta()/persist() của memory.js
// ═══════════════════════════════════════════════════════════════════════════

function freshMeta() {
    return { version: SCHEMA_VERSION, saved: [] };
}

function meta() {
    const ctx = getContext();
    if (!ctx.chatMetadata[THEATER_KEY]) {
        ctx.chatMetadata[THEATER_KEY] = freshMeta();
    }
    const m = ctx.chatMetadata[THEATER_KEY];
    if (m.version !== SCHEMA_VERSION) {
        // v1 là bản đầu, chưa có cấu trúc cũ nào cần chuyển đổi; khi nâng phiên bản sau này thì xử lý ở đây. Cứ bổ sung đủ trường.
        if (!Array.isArray(m.saved)) m.saved = [];
        m.version = SCHEMA_VERSION;
        persist();
    }
    return ctx.chatMetadata[THEATER_KEY];
}

function persist() {
    // Ghi xuống đĩa ngay (giống persist của store.js): tránh việc đổi bản lưu làm hủy lượt chống dội khiến lớp vĩnh viễn của Lăng bị mất.
    const ctx = getContext();
    if (!ctx) return;
    if (ctx.saveMetadata) ctx.saveMetadata();
    else ctx.saveMetadataDebounced?.();
}

export function loadSaved() {
    return meta().saved.slice();
}

// Nâng lên vĩnh viễn: đưa một bản nháp (hoặc kết quả đang hiển thị) vào chat_metadata. Kèm tiêu đề/nhãn người dùng điền.
export function promoteToSaved(piece) {
    const m = meta();
    if (m.saved.some(p => p.id === piece.id)) return; // lũy đẳng, tránh nâng trùng
    m.saved.push({ ...piece });
    persist();
}

export function deleteSaved(id) {
    const m = meta();
    const before = m.saved.length;
    m.saved = m.saved.filter(p => p.id !== id);
    if (m.saved.length !== before) persist();
}

// ═══════════════════════════════════════════════════════════════════════════
//  Kho mẫu (sách thế giới chuyên dụng, toàn cục, tuyệt đối không đưa vào AI)
// ═══════════════════════════════════════════════════════════════════════════
//
// Một mẫu = một entry WI: comment=tiêu đề, content=nội dung, disable=true (khóa kép).
// Đối ngoại phơi ra dưới dạng { uid, title, text }. Sách này không bao giờ được thêm vào selected_world_info / link thẻ nhân vật /
// chat lore — ST chỉ quét những sách được chọn, nên nó tuyệt đối không lọt vào bất kỳ ngữ cảnh sinh nội dung nào.

// Bảo đảm sách chuyên dụng tồn tại rồi trả về data của nó ({ entries:{uid:entry} }). Không dùng createNewWorldInfo
// (hàm đó gọi trigger('change') làm ST chuyển màn hình biên tập sách thế giới); thay bằng lưu thẳng một sách rỗng + làm mới danh sách.
//
// «Sách có tồn tại hay không» lấy kết quả thật mà loadWorldInfo trả về làm chuẩn (đọc từ máy chủ/cache, lấy thẳng theo tên sách),
// **tuyệt đối không** tin vào danh sách tên trong bộ nhớ getWorldInfoNames()/world_names — sau khi người dùng xóa sách này trong ST rồi tạo lại,
// danh sách đó có thể lệch pha với đĩa. Hễ dựa vào nó mà phán nhầm là «sách không tồn tại» thì bên dưới sẽ lấy một cuốn sách rỗng ghi đè lên cuốn sách thật trên đĩa,
// đè mất toàn bộ mẫu đã lưu (đúng cái lỗi người dùng đã báo). Bên trong loadWorldInfo, với những tên không nhận ra thì nó sẽ lùi về
// lấy theo đúng tên gốc (resolveWorldInfoName không tìm ra thì fallback về tên gốc), nên danh sách có lệch pha vẫn đọc được sách thật.
async function ensureBook() {
    const ctx = getContext();
    const data = await ctx.loadWorldInfo(TEMPLATE_BOOK);
    if (data) return data.entries ? data : { entries: {} };
    // loadWorldInfo trả về rỗng = máy chủ đúng là không có cuốn này → tạo một cuốn rỗng (tiện thể làm mới danh sách, cố hết sức thôi).
    await ctx.saveWorldInfo(TEMPLATE_BOOK, { entries: {} }, true);
    await ctx.updateWorldInfoList?.();
    return { entries: {} };
}

function entryToTemplate(uid, entry) {
    return {
        uid   : String(uid),
        title : String(entry.comment || '').trim() || '(Không có tiêu đề)',
        text  : String(entry.content || ''),
    };
}

export async function listTemplates() {
    const ctx = getContext();
    // Giống ensureBook: lấy kết quả thật của loadWorldInfo làm chuẩn, không vì danh sách trong bộ nhớ thiếu tên mà báo nhầm «chưa có mẫu nào».
    // Chỉ đọc chứ không tạo — sách thật sự không có thì loadWorldInfo trả rỗng, trả về [] luôn, không chủ động tạo.
    const data = await ctx.loadWorldInfo(TEMPLATE_BOOK);
    if (!data || !data.entries) return [];
    return Object.entries(data.entries)
        .map(([uid, entry]) => entryToTemplate(uid, entry))
        .sort((a, b) => Number(a.uid) - Number(b.uid));
}

// Tạo mới một entry WI làm mẫu. Ưu tiên dùng worldInfoEntry.create của context; context ở bản ST cũ
// không có object worldInfoEntry (bản cũ sẽ báo "reading 'create' of undefined"), khi đó lùi về việc tự
// cấp uid + mẫu entry tối giản. Sách này là của riêng Phác Họa, không bao giờ được tiêm vào, nên đủ trường để đọc/ghi là được.
function createTemplateEntry(ctx, data) {
    if (ctx.worldInfoEntry?.create) return ctx.worldInfoEntry.create(TEMPLATE_BOOK, data);
    let uid = 0;
    while (uid in data.entries) uid++;
    const entry = {
        uid, key: [], keysecondary: [], comment: '', content: '',
        constant: false, vectorized: false, selective: true, selectiveLogic: 0,
        order: 100, position: 0, disable: true, excludeRecursion: false,
        preventRecursion: false, probability: 100, useProbability: true, depth: 4,
    };
    data.entries[uid] = entry;
    return entry;
}

export async function addTemplate(title, text) {
    const ctx = getContext();
    const data = await ensureBook();
    const entry = createTemplateEntry(ctx, data);
    if (!entry) throw new Error('Không tạo được mục mẫu');
    entry.comment = String(title || '').trim();
    entry.content = String(text || '');
    entry.disable = true;   // khóa kép: dù sách có bị chọn nhầm thì mục này cũng không kích hoạt
    entry.key = [];
    entry.constant = false;
    await ctx.saveWorldInfo(TEMPLATE_BOOK, data, true);
    return entryToTemplate(entry.uid, entry);
}

// Thêm hàng loạt: một lần ensureBook + vòng lặp create (dùng chung một object data, việc cấp uid không đụng nhau) + **một lần** saveWorldInfo.
// Với hàng nghìn mục mà gọi addTemplate từng cái sẽ kích hoạt hàng nghìn lượt load/save, chắc chắn giật; gom lại thì I/O đĩa chỉ còn một lần.
// items: [{ title, text }]. Trả về số mục vào kho thành công.
export async function addTemplatesBatch(items) {
    const list = (Array.isArray(items) ? items : []).filter(it => it && (String(it.title || '').trim() || String(it.text || '').trim()));
    if (!list.length) return 0;
    const ctx = getContext();
    const data = await ensureBook();
    for (const it of list) {
        const entry = createTemplateEntry(ctx, data);
        if (!entry) continue;
        entry.comment  = String(it.title || '').trim();
        entry.content  = String(it.text || '');
        entry.disable  = true;
        entry.key      = [];
        entry.constant = false;
    }
    await ctx.saveWorldInfo(TEMPLATE_BOOK, data, true);
    return list.length;
}

export async function updateTemplate(uid, title, text) {
    const ctx = getContext();
    const data = await ctx.loadWorldInfo(TEMPLATE_BOOK);
    if (!data || !data.entries || !data.entries[uid]) return;
    data.entries[uid].comment = String(title || '').trim();
    data.entries[uid].content = String(text || '');
    data.entries[uid].disable = true;
    await ctx.saveWorldInfo(TEMPLATE_BOOK, data, true);
}

export async function deleteTemplate(uid) {
    const ctx = getContext();
    const data = await ctx.loadWorldInfo(TEMPLATE_BOOK);
    if (!data || !data.entries || !data.entries[uid]) return;
    delete data.entries[uid];
    await ctx.saveWorldInfo(TEMPLATE_BOOK, data, true);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Dọn dẹp cache trên máy (những key «gắn với thiết bị» trong localStorage: vị trí giao diện + bản nháp Lăng)
// ═══════════════════════════════════════════════════════════════════════════
//
// Từ 2.0.0, sản phẩm Điểm/Tuyến/Diện/Gian đã dời vào chat_metadata, localStorage chỉ nên giữ những thứ gắn với thiết bị:
//   · Vị trí giao diện  sp-fab-pos / sp-outline-chat-h / sp-pos / sp-size
//   · Bản nháp Lăng     sp-cache-{chatId}-theater-draft-user (bản nháp cửa sổ trượt, không đồng bộ giữa thiết bị)
// **Tuyệt đối không** được xóa bừa mọi key sp- nữa: với những cuộc trò chuyện người dùng cũ chưa mở lại, Điểm/Tuyến/Diện/Gian của họ
// vẫn nằm trong localStorage dưới dạng sp-cache-{chatId}-{kind}-{scope}, chờ CHAT_CHANGED chuyển đổi lười;
// xóa ở đây là mất dữ liệu. Vì vậy isDeviceLocalKey khoanh vùng chính xác «vị trí giao diện + bản nháp Lăng», ngoài ra không đụng gì.

const UI_LOCAL_KEYS = ['sp-fab-pos', 'sp-outline-chat-h', 'sp-pos', 'sp-size'];

function isDeviceLocalKey(k) {
    if (!k) return false;
    if (UI_LOCAL_KEYS.includes(k)) return true;
    // Bản nháp Lăng: sp-cache-{chatId}-theater-draft-user (key sp-cache duy nhất có đoạn theater-draft)
    return k.startsWith('sp-cache-') && /-theater-draft(-|$)/.test(k);
}

export function pluginCacheBytes() {
    let bytes = 0;
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!isDeviceLocalKey(k)) continue;
        const v = localStorage.getItem(k) || '';
        bytes += (k.length + v.length) * 2; // UTF-16
    }
    return bytes;
}

export function clearPluginCache() {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (isDeviceLocalKey(k)) doomed.push(k);
    }
    doomed.forEach(k => localStorage.removeItem(k));
    return doomed.length;
}

export function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Đường ống sinh nội dung (agent hai chặng, khớp với API thật postChatCompletion)
// ═══════════════════════════════════════════════════════════════════════════

function buildWriteMessages(userInput) {
    const s = _getSettings();
    const story = _getStoryContext ? _getStoryContext() : { sysBlocks: [], userName: 'Người dùng', charName: 'Nhân vật' };

    const sysParts = [
        `Bạn là một tiểu thuyết gia, đang sáng tác một đoạn tiểu kịch trường độc lập (tuyến giả định / ngoại truyện / khả năng khác) cho câu chuyện giữa ${story.userName} và ${story.charName}.`,
        // Lời nhắc viết văn (văn phong + văn mẫu gộp chung một ô, tiện dán nguyên đoạn thiết lập sẵn)
        s.theaterStylePrompt ? String(s.theaterStylePrompt).trim() : '',
        ...(Array.isArray(story.sysBlocks) ? story.sysBlocks : []),
        `[Yêu cầu khi viết]`,
        `- Viết thẳng phần nội dung, không giải thích, không rào trước đón sau, không đặt tiêu đề`,
        `- Miêu tả giác quan và hành động thật cụ thể, tránh khái quát chung chung và những mở đầu/kết thúc sáo mòn`,
        `- Độ dài theo yêu cầu hoặc theo chỉ dẫn trong mẫu; không nêu rõ thì cứ kết thúc tự nhiên, đừng cố kéo dài`,
    ].filter(Boolean);

    return [
        { role: 'system', content: sysParts.join('\n\n') },
        { role: 'user',   content: String(userInput || '').trim() },
    ];
}

function buildBeautifyMessages(raw) {
    const s = _getSettings();
    const defaultBeautify =
`Bạn là một người dàn trang HTML. Hãy chuyển đoạn văn tiểu thuyết người dùng đưa thành một **đoạn HTML tiết chế, dễ đọc** để hiển thị trên trang web.
[Ràng buộc bắt buộc]
- Tuyệt đối không viết thẻ <style>, không viết <script>, không tham chiếu CSS/phông chữ/hình ảnh bên ngoài; màu sắc, nền, viền, cỡ chữ, khoảng cách... của khung chứa gốc và bốn loại phần tử ngữ nghĩa cố định đều để CSS của trang lo, cấm dùng style nội tuyến để ghi đè lên những phần tử đó
- Không viết vỏ <html>/<head>/<body>, chỉ xuất ra đoạn có thể chèn thẳng vào
- Lớp ngoài cùng xin dùng một khung chứa gốc mang ngữ nghĩa, ví dụ <div class="sp-theater-prose">; phần nội dung thông thường vẫn chủ yếu là các đoạn <p> bình thường, cấm biến mỗi đoạn thành một thẻ bài
- Chỉ dùng một lượng nhỏ các lớp ngữ nghĩa cố định sau và phải theo đúng cấu trúc thật của bản gốc, đừng tự bịa tên lớp: chỗ chuyển cảnh/chỗ phân cách trong bản gốc thì dùng .sp-theater-scene-break; khi bản gốc thật sự có thư từ, đoạn chat, mẩu giấy, bản tin, hồ sơ và các vật mang nội dung khác thì dùng .sp-theater-inset; khi bản gốc thật sự có tiếng lòng, hồi ức hay đoạn lạc ra ngoài mà hợp để thể hiện nhạt đi thì dùng .sp-theater-aside; chỉ khi bọc một vài câu ngắn then chốt của bản gốc thì dùng .sp-theater-emphasis
- Nếu bản gốc không có dấu phân cách nhưng thật sự cần một chỗ chuyển cảnh mang tính trang trí thì bắt buộc xuất ra chính xác <div class="sp-theater-scene-break"></div>, không kèm bất kỳ khoảng trắng, xuống dòng hay nút văn bản nào; nếu bản gốc đã có dấu phân cách như ***, —— thì giữ nguyên bản gốc và đặt vào phần tử đó, đừng thêm chữ hay chấm tròn mới
- Giữ nguyên toàn bộ chữ nghĩa của bản gốc, không thêm bớt tình tiết, không thêm tiêu đề, nhãn, lời giải thích hay chữ trên biểu tượng, không viết lại nội dung; không được bịa ra cấu trúc chỉ để phục vụ việc dàn trang
- **Cỡ chữ phần nội dung phải tiết chế, thiên nhỏ**: nội dung dùng khoảng 13px (cỡ 0.87em), chiều cao dòng 1.7 (tiếng Việt có dấu thanh và dấu phụ nên cần khoảng hở dọc rộng hơn, không được để dòng chèn lên nhau); tuyệt đối không phóng to nội dung, không dùng cỡ chữ quá lớn; tiêu đề (nếu có) tối đa 1.1em
- **Không nới rộng khoảng cách chữ**: không đặt letter-spacing (hoặc đặt 0/normal); tiếng Việt là chữ Latinh, giãn chữ ra sẽ khiến từ bị vỡ và rất khó đọc
- Phối màu nhã nhặn, khoảng trắng thoáng, dễ đọc; đừng đặt chiều rộng cố định cho khung chứa, để nó tự co giãn theo bảng điều khiển; chỗ chuyển cảnh chỉ dùng đường mảnh/ký hiệu nhỏ, vật mang nội dung chỉ làm khung nhẹ tương phản thấp, đoạn lạc ra ngoài thì dịu, câu ngắn then chốt chỉ nhấn một lượng nhỏ
- Cấm chiều rộng cố định, cỡ chữ phóng đại, hoạt ảnh, trang trí bão hòa cao và việc tự bịa tên lớp; với cấu trúc thông thường thì ưu tiên dùng thẻ bình thường và giữ sự tiết chế, đừng trang trí nặng nề; nếu thật sự cần dàn trang cơ bản thì ưu tiên dùng các lớp cố định nói trên
Xuất thẳng HTML, đừng bọc trong khối mã, đừng giải thích.`;
    const sys = s.theaterBeautifyPrompt ? String(s.theaterBeautifyPrompt).trim() : defaultBeautify;
    return [
        { role: 'system', content: sys },
        { role: 'user',   content: String(raw || '') },
    ];
}

// DOMPurify làm sạch: FORBID_TAGS:['style'] lột bỏ khối <style> (phần làm đẹp chỉ được dùng inline style),
// mặc định đã chặn <script>/on*, triệt tận gốc việc rò rỉ kiểu dáng và tiêm mã script.
function sanitizeHtml(htmlRaw) {
    const purifier = globalThis.DOMPurify;
    if (purifier && typeof purifier.sanitize === 'function') {
        return purifier.sanitize(String(htmlRaw || ''), { FORBID_TAGS: ['style'] });
    }
    // DOMPurify không dùng được (về lý thuyết không xảy ra) — lùi về thoát ký tự thuần văn bản, tuyệt đối không cho HTML trần lọt qua
    console.warn('[SP theater] DOMPurify không dùng được, lùi về văn bản thuần');
    const div = document.createElement('div');
    div.textContent = String(htmlRaw || '');
    return div.innerHTML;
}

// Tạo một đoạn tiểu kịch trường. Trả về { piece } hoặc ném lỗi. piece đã tự động lưu thành bản nháp.
// onStage(stageText) để UI cập nhật dòng chữ đang tải ('Khúc xạ' / 'Kết xuất').
export async function generate(userInput, { signal, onStage, templateSource = null } = {}) {
    if (_generating) throw new Error('Đang tạo, vui lòng chờ một chút');
    if (!String(userInput || '').trim()) throw new Error('Hãy điền yêu cầu cho tiểu kịch trường trước');
    if (!_callWriteApi || !_callBeautifyApi) throw new Error('Lăng chưa được khởi tạo đúng cách');

    _generating = true;
    // Số chữ do yêu cầu/lời nhắc trong mẫu ràng buộc; ở đây cấp đủ hạn mức sinh nội dung (30000) để mô hình suy luận không bị chuỗi suy nghĩ ăn hết
    const writeMaxTokens = 30000;

    try {
        // ── Agent 1: viết văn (Lăng = khúc xạ) ──
        onStage?.('Khúc xạ');
        const raw = await _callWriteApi(buildWriteMessages(userInput), {
            maxTokens: writeMaxTokens,
            signal,
        });
        if (!String(raw || '').trim()) throw new Error('Agent viết văn trả về rỗng, hãy thử lại hoặc sửa đầu vào');

        // ── Agent 2: làm đẹp (kết xuất) ──
        onStage?.('Kết xuất');
        let htmlRaw = '';
        try {
            htmlRaw = await _callBeautifyApi(buildBeautifyMessages(raw), {
                maxTokens: writeMaxTokens,
                signal,
            });
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            console.warn('[SP theater] Agent làm đẹp thất bại, lùi về kết xuất văn bản thuần:', err);
        }
        // Làm đẹp trả rỗng/lỗi → dự phòng: giao cho renderAiMessageHtml của index.js (được tiêm vào làm bộ kết xuất chống hụt)
        const html = String(htmlRaw || '').trim()
            ? sanitizeHtml(htmlRaw)
            : sanitizeHtml(_fallbackRender ? _fallbackRender(raw) : raw);

        const piece = {
            id   : (crypto?.randomUUID?.() || `t-${Date.now()}-${Math.floor(performance.now())}`),
            title: '',
            raw  : String(raw),
            html,
            ts   : Date.now(),
            // Lưu lại đúng đầu vào thực tế tại thời điểm sinh nội dung; sau này mẫu có bị đổi tên/xóa hoặc người dùng sửa lần hai thì xem lại vẫn chuẩn.
            templateSource: templateSource?.input
                ? { uid: String(templateSource.uid || ''), title: String(templateSource.title || '(Không có tiêu đề)'), input: String(templateSource.input) }
                : undefined,
        };
        pushDraft(piece);   // tự lưu bản nháp (cửa sổ trượt)
        return { piece };
    } finally {
        _generating = false;
    }
}

// Bộ kết xuất chống hụt (khi làm đẹp thất bại thì đưa raw qua messageFormatting của ST), do index.js tiêm vào
let _fallbackRender = null;

// ═══════════════════════════════════════════════════════════════════════════
//  init
// ═══════════════════════════════════════════════════════════════════════════

let _listeners = { chat: null };

export function initTheater({ getSettings, callWriteApi, callBeautifyApi, getStoryContext, fallbackRender } = {}) {
    if (getSettings)     _getSettings = getSettings;
    if (callWriteApi)    _callWriteApi = callWriteApi;
    if (callBeautifyApi) _callBeautifyApi = callBeautifyApi;
    if (getStoryContext) _getStoryContext = getStoryContext;
    if (fallbackRender)  _fallbackRender = fallbackRender;

    // Xóa cờ đang tạo khi đổi chat (việc abort fetch in-flight do controller của index.js lo)
    const off = (evt, fn) => { if (fn) eventSource.removeListener?.(evt, fn); };
    off(event_types.CHAT_CHANGED, _listeners.chat);
    _listeners.chat = () => { _generating = false; };
    eventSource.on(event_types.CHAT_CHANGED, _listeners.chat);
}

export { TEMPLATE_BOOK, THEATER_DRAFT_CAP };
