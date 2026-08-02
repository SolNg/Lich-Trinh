// memory.js — Story memory system for ST-SevenDaysCal
//
// Architecture (Plan C: single objective memory + view-tagged injection):
//
//   L0: floor-group summary — every N AI floors → 1 L0 entry (default N=5)
//   L1: chapter summary — every M L0 entries → 1 L1 entry (default M=10)
//
// All storage lives in chat_metadata[MEMORY_KEY]. Persists in the chat file
// server-side — no localStorage, follows the chat.
//
// The most recent group (containing the latest AI floor) is intentionally
// NEVER summarized, to survive rerolls. L0 for group [k*N .. (k+1)*N - 1]
// only fires once at least one AI floor beyond (k+1)*N-1 exists.
//
// Text content of each group is hashed and stored with the L0 entry. If any
// floor in the group changes (reroll / edit / swipe), the hash mismatches and
// the L0 is invalidated + requeued. This covers ST event unreliability.

import { getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

const MEMORY_KEY = 'sp-memory';
const SCHEMA_VERSION = 3;   // v3 = tag-stripped floor text (v2 summaries included thinking/widget noise; requires rebuild)

// ─── Settings (per-plugin, not per-chat) ─────────────────────────────────────
// Stored via caller; memory.js just reads them via a getter injected at init.

let _getSettings = () => ({
    memoryEnabled  : true,
    memoryL0Group  : 5,       // AI floors per L0 entry
    memoryL1Group  : 10,      // L0 entries per L1 chapter
    memorySkipShort: 50,      // skip AI floors shorter than N chars from L0 input
});

// ─── API caller injection ────────────────────────────────────────────────────
let _callApi = null;

// ─── State ───────────────────────────────────────────────────────────────────
let _queue = [];
let _running = false;
let _currentJob = null;           // job currently in handleJob (must be declared: strict-mode ES module)
let _abortController = null;      // reserved for rebuild flow (see abortRebuild)
let _jobAbortController = null;   // shared signal for per-job fetches; aborted on CHAT_CHANGED

// ─── Utility: fast non-crypto hash ───────────────────────────────────────────
function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

// ─── chat_metadata access ────────────────────────────────────────────────────
function meta() {
    const ctx = getContext();
    if (!ctx.chatMetadata[MEMORY_KEY]) {
        ctx.chatMetadata[MEMORY_KEY] = freshMeta();
    }
    // Version mismatch: wipe (hash algorithm changed with content sanitizer,
    // so old summaries can't be validated) but stash a migration notice for
    // the UI to surface once. Users see a toast on next chat switch / panel
    // open explaining why their summaries are reset.
    const m = ctx.chatMetadata[MEMORY_KEY];
    if (m.version !== SCHEMA_VERSION) {
        const l0Count = m.L0 ? Object.keys(m.L0).length : 0;
        const l1Count = Array.isArray(m.L1) ? m.L1.length : 0;
        const fresh = freshMeta();
        // Only surface a notice if the previous chat actually had summaries
        // built up; brand-new chats shouldn't trigger a "migration" popup.
        if (l0Count > 0 || l1Count > 0) {
            fresh._migration = { fromVersion: m.version ?? 1, l0Count, l1Count, ts: Date.now() };
        }
        ctx.chatMetadata[MEMORY_KEY] = fresh;
        persist();
    }
    return ctx.chatMetadata[MEMORY_KEY];
}

function freshMeta() {
    return {
        version: SCHEMA_VERSION,
        L0: {},          // groupKey (e.g. "5-9") → { range: [startMid, endMid], text, hash, ts, failCount }
        L1: [],          // array of { range: [startMid, endMid], text, ts }
        failed: {},      // groupKey → { count, lastErr }
        system: { paused: false, consecutiveFails: 0, lastError: null },
    };
}

function persist() {
    const ctx = getContext();
    ctx.saveMetadataDebounced?.();
}

// ─── Content sanitizer ──────────────────────────────────────────────────────
// Strip all tag-wrapped blocks (thinking, reasoning, outline_widget,
// calendar_widget, details/summary, HTML markup, etc.) — the summarizer only
// wants the narrative prose. Both paired blocks and stray tags are removed,
// plus HTML/XML comments. Applied at getAiFloors() so every downstream
// consumer (grouping, hashing, prompt building) sees the same clean text.
//
// Two user-configurable name lists override the default behavior:
//   keepTags  → PROTECT list. Contents inside these tags survive stripping;
//               the tags themselves are removed but their inner text is kept.
//               Default 'content'. Fixes the "AI wraps narrative in <content>
//               and default strip nukes it" edge case some cards hit.
//   extraTags → EXTRA strip list. Explicitly names tags that MUST be removed
//               with their content. Redundant with default behavior but lets
//               users document intent (e.g. write 'think,reasoning').
function parseTagList(csv) {
    return String(csv || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(s => /^[\p{L}][\p{L}\p{N}_-]*$/u.test(s));
}

export function stripTags(raw, opts = {}) {
    if (!raw) return '';
    const keep  = parseTagList(opts.keepTags  ?? 'content');
    const extra = parseTagList(opts.extraTags ?? '');
    let s = String(raw);
    // 1. HTML/XML comments
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    // 2. Extract keep-list blocks into placeholders BEFORE any stripping runs,
    //    so the default "delete paired tags with content" pass won't nuke them.
    //    Restored (as bare inner text) at the end.
    const keepStash = [];
    for (const name of keep) {
        const rx = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`, 'gi');
        s = s.replace(rx, (_m, inner) => {
            keepStash.push(inner);
            return ` KEEP${keepStash.length - 1} `;
        });
    }
    // 3. Extra strip list — delete these tags + content entirely (redundant with
    //    the default pass but explicit for user clarity + future-proofs if we
    //    ever change the default).
    for (const name of extra) {
        const rx = new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${name}\\s*>`, 'gi');
        let prev;
        do { prev = s; s = s.replace(rx, ''); } while (s !== prev);
    }
    // 4. Default: delete every remaining paired tag WITH its content.
    //    Multi-pass to handle nested same-name tags.
    let prev;
    do {
        prev = s;
        s = s.replace(/<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/g, '');
    } while (s !== prev);
    // 5. Any remaining self-closing / orphan tags
    s = s.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/g, '');
    // 6. Restore keep-list inner content (bare, no tags)
    s = s.replace(/ KEEP(\d+) /g, (_m, idx) => keepStash[+idx] ?? '');
    // 7. Second cleaning pass — restored kept content may itself contain
    //    noisy tags (e.g. <content><thinking>...</thinking>nội dung chính</content>).
    //    Run the default + orphan strip again. Keep list is NOT re-applied
    //    here (would re-stash then loop); protection is by design outermost-only.
    do {
        prev = s;
        s = s.replace(/<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/g, '');
    } while (s !== prev);
    s = s.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/g, '');
    // 8. Collapse the whitespace left behind by removed blocks
    s = s.replace(/\n{3,}/g, '\n\n').trim();
    return s;
}

// ─── Chat helpers ────────────────────────────────────────────────────────────
function getChat() { return getContext().chat || []; }

// Returns all AI floors (including hidden — is_system=true means hidden in ST).
// Text is sanitized: thinking/reasoning/widget/HTML tags all stripped,
// leaving only narrative prose for the summarizer. User can influence which
// tags to keep/strip via keepTags/extraTags settings.
function getAiFloors() {
    const chat = getChat();
    const settings = _getSettings();
    const stripOpts = { keepTags: settings.keepTags, extraTags: settings.extraTags };
    const out = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (m && !m.is_user) {
            const raw = m.mes || '';
            out.push({ mesid: String(i), text: stripTags(raw, stripOpts), rawLen: raw.length });
        }
    }
    return out;
}

// Group AI floors into fixed-size chunks. Returns array of groups, each:
// { key: "startMid-endMid", floors: [{mesid, text}, ...] }
// Latest group (containing the newest AI floor) is EXCLUDED — never summarized.
function getStableGroups() {
    const settings = _getSettings();
    const N = Math.max(1, +settings.memoryL0Group || 5);
    const floors = getAiFloors();
    const groups = [];
    for (let i = 0; i + N <= floors.length; i += N) {
        const slice = floors.slice(i, i + N);
        groups.push({
            key   : `${slice[0].mesid}-${slice[slice.length - 1].mesid}`,
            floors: slice,
        });
    }
    // If the last group ended exactly at the newest AI floor, drop it (delay-by-one rule)
    if (groups.length && floors.length && groups[groups.length - 1].floors.slice(-1)[0].mesid === floors[floors.length - 1].mesid) {
        groups.pop();
    }
    return groups;
}

// Hash the combined text of a group's floors — invalidates on any reroll/edit
function groupHash(group) {
    return hashStr(group.floors.map(f => f.text).join('\x1f'));
}

// Xác định «nhóm tầng này có nội dung gốc thật, nhưng sau khi làm sạch thì gần như trống» — điển hình là thẻ nhân vật
// bọc toàn bộ nội dung trong thẻ tùy chỉnh (ví dụ <gametxt>), trong khi danh sách thẻ được giữ lại mặc định chỉ có content,
// khiến nội dung bị xóa sạch sau khi làm sạch và không tạo được tóm tắt.
// Phân biệt với «mô hình không trả về»: đây là kết quả làm sạch mang tính tất định, không nên thử lại vô ích hay bắt người dùng đi chỉnh mô hình.
// Ngưỡng: tổng độ dài nội dung gốc đủ lớn (>= số tầng × 40 ký tự, loại trừ nhóm vốn đã trống) nhưng sau khi làm sạch và bỏ khoảng trắng thì chưa tới 20 ký tự.
function isStrippedEmpty(group) {
    const floors = group.floors || [];
    if (!floors.length) return false;
    let rawTotal = 0, netTotal = 0;
    for (const f of floors) {
        rawTotal += Number(f.rawLen) || 0;
        netTotal += String(f.text || '').replace(/\s+/g, '').length;
    }
    return rawTotal >= floors.length * 40 && netTotal < 20;
}

// ─── Prompts ─────────────────────────────────────────────────────────────────
function buildL0Prompt(prevSummary, groupFloors) {
    const skipShort = +_getSettings().memorySkipShort || 50;
    const body = groupFloors
        .filter(f => (f.text || '').trim().length >= skipShort || groupFloors.length === 1)
        .map((f, i) => `[Tầng ${f.mesid}]\n${String(f.text || '').slice(0, 2000)}`)
        .join('\n\n');
    return [
        {
            role: 'system',
            content: `Bạn là một người ghi chép tự sự khách quan, đứng ở ngôi thứ ba, có nhiệm vụ gộp ${groupFloors.length} tầng hội thoại liên tiếp thành một bản tóm tắt có cấu trúc.

[Nguyên tắc cốt lõi]
- Ngôi thứ ba khách quan, không mang màu sắc cảm xúc, không nhập vai, không phán xét theo góc nhìn nào
- Ghi lại "ai đã làm gì, ai đã nói gì, chuyện gì đã xảy ra"
- Thứ tự ưu tiên khi mô tả thời gian: ① nguyên văn có ngày tháng năm cụ thể → dùng "YYYY-MM-DD" hoặc "ngày D tháng M năm YYYY" kèm buổi trong ngày (ví dụ "2024-03-15 buổi sáng"); ② chỉ có số ngày tương đối → "Ngày thứ N + buổi" (ví dụ "Ngày thứ 3 buổi sáng"); ③ hoàn toàn không có → ghi "không đề cập". Tuyệt đối không quy đổi hay suy đoán. Giữa các đoạn, đừng lẫn lộn "Ngày thứ 3" với "ngày 15 tháng 3"
- Chỉ trích xuất nội dung thật sự có trong nhóm tầng này, không tự bịa hay suy diễn
- Những lời thoại hàm ý sâu xa, hành động bất thường, câu nói bỏ lửng, lời lỡ miệng và các phục bút tiềm tàng khác thì viết thẳng vào trường "Sự kiện" như một phần của mô tả khách quan (ví dụ "Lý Tứ nhắc tới lá thư chưa mở của cha để lại"), đừng tách ra quy nạp riêng
- Nếu một tầng nào đó trong nhóm chỉ là chuyện phiếm ít giá trị hoặc quá ngắn thì có thể lược đi trong bản tóm tắt
- Nội dung NSFW / thân mật không ghi chi tiết cụ thể, chỉ quy về một câu sự thật mang tính tự sự (ví dụ "hai người phát sinh quan hệ"), trừ khi trong đó có lời hứa hẹn, tổn thương thật sự, tiết lộ thân phận, mang thai, bệnh tật... tức những sự kiện quan trọng có ảnh hưởng về sau
- Mỗi trường một dòng riêng, định dạng nghiêm ngặt`,
        },
        {
            role: 'user',
            content: `[Bản tóm tắt đoạn trước (để hiểu đại từ và ngữ cảnh, có thể trống)]
${prevSummary || '(Không có phần trước, đoạn này là mở đầu)'}

[Nguyên văn đoạn này (${groupFloors.length} tầng liên tiếp)]
${body}

Hãy trích xuất thông tin theo cấu trúc các trường dưới đây, mỗi trường một dòng, sau tên trường là dấu hai chấm, không gộp trường:

Mốc thời gian: khoảng thời gian của đoạn này, theo dạng "điểm đầu → điểm cuối" (**ưu tiên thời gian tuyệt đối** như "2024-03-15 buổi sáng → 2024-03-16 chiều tối"; nếu nguyên văn chỉ cho số ngày tương đối thì dùng "Ngày thứ 3 buổi sáng → Ngày thứ 4 hoàng hôn"; không lẫn lộn hai kiểu, chỉ dùng một kiểu); nếu trong cốt truyện xuất hiện bước ngoặt thời gian then chốt (nút thật sự đẩy cốt truyện đi, không phải dấu thời gian của từng tầng) thì bổ sung trong ngoặc sau khoảng thời gian (ví dụ "…(Ngày thứ 3 nửa đêm XX xảy ra)"); nếu không có thì ghi "không đề cập"
Bối cảnh: nơi diễn ra chính (có thể nhiều nơi, theo thứ tự), nếu không có thì ghi "không đề cập"
Sự kiện: những hành động và tình tiết then chốt thật sự xảy ra trong đoạn này, theo trình tự thời gian, 80-150 chữ (trình bày khách quan, gồm lời thoại, hành động, chi tiết hàm ý sâu xa; không gồm độc thoại nội tâm)
Nhân vật: những biến đổi thực chất về lập trường, quan hệ, cảm xúc của các nhân vật xuất hiện, 40-70 chữ; nếu không có biến đổi thực chất thì ghi "không"

Chỉ xuất ra bốn dòng này, không giải thích thêm.`,
        },
    ];
}

function buildL1Prompt(l0Entries) {
    const body = l0Entries.map(e => `[Tầng ${e.range[0]}-${e.range[1]}]\n${e.text}`).join('\n\n');
    return [
        {
            role: 'system',
            content: `Bạn là một người ghi chép tự sự khách quan, đứng ở ngôi thứ ba, có nhiệm vụ nén nhiều đoạn tóm tắt L0 liên tiếp thành một bản tóm tắt chương.

[Nguyên tắc cốt lõi]
- Giữ nguyên mốc thời gian, nối lại theo trình tự trước sau (ví dụ "Ngày thứ 5 buổi sáng → Ngày thứ 7 hoàng hôn")
- Ngôi thứ ba khách quan
- Giữ tính cụ thể của các sự kiện then chốt, không khái quát hóa
- Những lời thoại hàm ý sâu xa, hành động bất thường, ẩn ý chưa được thu hồi thì giữ lại như một phần của mạch kể sự kiện; phục bút đã thu hồi thì cứ để trôi theo dòng sự kiện sau đó
- Nội dung NSFW / thân mật không giữ chi tiết cụ thể, chỉ quy về một câu sự thật mang tính tự sự, trừ khi trong đó có lời hứa hẹn, tổn thương thật sự, tiết lộ thân phận, mang thai, bệnh tật... tức những sự kiện quan trọng có ảnh hưởng về sau
- Mỗi trường một dòng riêng`,
        },
        {
            role: 'user',
            content: `Dưới đây là ${l0Entries.length} đoạn tóm tắt L0, hãy gộp lại và nén:

${body}

Hãy xuất ra theo cấu trúc các trường dưới đây, mỗi trường một dòng:

Khoảng thời gian: từ mốc thời gian đầu tiên tới mốc cuối cùng của chương này (**ưu tiên thời gian tuyệt đối** YYYY-MM-DD, không có thì lùi về "Ngày thứ N", giữ nhất quán với L0, không lẫn lộn)
Sự kiện chính: liệt kê các sự kiện quan trọng theo trình tự thời gian, sự kiện phải nêu rõ nhân vật và địa điểm cụ thể, gồm lời thoại then chốt, hành động, chi tiết hàm ý sâu xa, 160-260 chữ
Biến đổi quan hệ: những biến đổi thực chất về lập trường/quan hệ của nhân vật, 50-90 chữ; nếu không có thì ghi "không có thay đổi rõ rệt"

Chỉ xuất ra ba dòng này, không giải thích thêm.`,
        },
    ];
}

// ─── Job queue ───────────────────────────────────────────────────────────────
function enqueue(job) {
    const key = `${job.type}:${job.groupKey || job.range?.join('-') || ''}`;
    if (_queue.some(j => `${j.type}:${j.groupKey || j.range?.join('-') || ''}` === key)) return;
    _queue.push(job);
    if (!_running) processQueue();
}

async function processQueue() {
    if (_running) return;
    _running = true;
    while (_queue.length) {
        const job = _queue.shift();
        _currentJob = job;
        try { await handleJob(job); }
        catch (err) { console.warn('[SP memory] job failed:', job, err); }
        _currentJob = null;
    }
    _running = false;
}

async function handleJob(job) {
    if (!_callApi) return;
    if (job.type === 'L0') {
        await runL0(job.groupKey);
    } else if (job.type === 'L1') {
        await runL1(job.range);
    }
    persist();
}

// ─── L0 generation ───────────────────────────────────────────────────────────
async function runL0(groupKey) {
    const m = meta();
    const groups = getStableGroups();
    const group = groups.find(g => g.key === groupKey);
    if (!group) return;

    const hash = groupHash(group);
    const existing = m.L0[groupKey];
    if (existing && existing.hash === hash) return;

    // Nội dung sau khi làm sạch gần như trống: đây là kết quả tất định, không gọi mô hình, không tính là mô hình lỗi.
    // Đánh dấu rồi trả về ngay; bảng điều khiển dựa vào đó nhắc người dùng kiểm tra lại thiết lập «thẻ được giữ lại» (nhiều khả năng nội dung bị bọc trong thẻ tùy chỉnh).
    if (isStrippedEmpty(group)) {
        recordStrippedEmpty(groupKey);
        if (m.L0[groupKey]) delete m.L0[groupKey];
        return;
    }

    // Find previous group's summary for context
    const idx = groups.findIndex(g => g.key === groupKey);
    let prevSummary = '';
    if (idx > 0) {
        prevSummary = m.L0[groups[idx - 1].key]?.text || '';
    }

    // Snapshot chatId — after the await, we may be in a different chat
    const chatIdSnap = getContext().chatId;
    const messages = buildL0Prompt(prevSummary, group.floors);
    let response = '';
    try {
        response = await _callApi(messages, _jobAbortController?.signal);
    } catch (err) {
        if (err?.name === 'AbortError') return;          // chat switched; drop silently
        recordFailure(groupKey, err);
        return;
    }

    // Guard: don't write results into a different chat's metadata
    if (getContext().chatId !== chatIdSnap) return;

    if (!response || response.length < 10) {
        recordFailure(groupKey, new Error('Phản hồi trống hoặc quá ngắn'));
        return;
    }

    m.L0[groupKey] = {
        range: [group.floors[0].mesid, group.floors[group.floors.length - 1].mesid],
        text : response.trim(),
        hash,
        ts   : Date.now(),
    };
    delete m.failed[groupKey];
    m.system.consecutiveFails = 0;
    if (m.system.paused) m.system.paused = false;

    maybeQueueL1();
}

function recordFailure(groupKey, err) {
    const m = meta();
    const rec = m.failed[groupKey] || { count: 0 };
    rec.count += 1;
    rec.lastErr = String(err?.message || err);
    delete rec.stripped;                 // lần này đúng là mô hình lỗi, xóa dấu «trống do làm sạch» có thể còn sót
    m.failed[groupKey] = rec;
    m.system.consecutiveFails += 1;
    m.system.lastError = rec.lastErr;
    if (rec.count >= 3 || m.system.consecutiveFails >= 3) {
        m.system.paused = true;
    }
}

// Nội dung sau khi làm sạch gần như trống: đánh thẳng thành permaFailed (count=3, không thử lại nữa), nhưng gắn dấu stripped
// để phân biệt với lỗi mô hình, và **không kích hoạt tạm dừng toàn cục/consecutiveFails** — đây không phải lỗi của mô hình, đừng bắt người dùng đi chỉnh mô hình.
function recordStrippedEmpty(groupKey) {
    const m = meta();
    m.failed[groupKey] = { count: 3, lastErr: 'Nội dung sau khi làm sạch gần như trống, hãy kiểm tra lại thiết lập thẻ', stripped: true };
    m.system.lastError = 'Nội dung sau khi làm sạch gần như trống, hãy kiểm tra lại thiết lập thẻ';
}

// ─── L1 compression ──────────────────────────────────────────────────────────
function maybeQueueL1() {
    const m = meta();
    const groups = getStableGroups();
    const l0Keys = groups.map(g => g.key).filter(k => m.L0[k]);
    const M = Math.max(2, +_getSettings().memoryL1Group || 10);
    for (let start = 0; start + M <= l0Keys.length; start += M) {
        const chunk = l0Keys.slice(start, start + M);
        const range = [
            m.L0[chunk[0]].range[0],
            m.L0[chunk[chunk.length - 1]].range[1],
        ];
        const already = m.L1.some(l1 => l1.range[0] === range[0] && l1.range[1] === range[1]);
        if (!already) enqueue({ type: 'L1', range });
    }
}

async function runL1(range) {
    const m = meta();
    const [startMid, endMid] = range;
    const startNum = parseInt(startMid, 10);
    const endNum   = parseInt(endMid, 10);
    const entries = [];
    for (const [k, l0] of Object.entries(m.L0)) {
        const s = parseInt(l0.range[0], 10);
        const e = parseInt(l0.range[1], 10);
        if (s >= startNum && e <= endNum) entries.push(l0);
    }
    entries.sort((a, b) => parseInt(a.range[0], 10) - parseInt(b.range[0], 10));
    if (entries.length < 2) return;

    const chatIdSnap = getContext().chatId;
    const messages = buildL1Prompt(entries);
    let response = '';
    try {
        response = await _callApi(messages, _jobAbortController?.signal);
    } catch (err) {
        if (err?.name === 'AbortError') return;
        m.system.lastError = 'Nén L1 thất bại: ' + String(err?.message || err);
        return;
    }
    if (getContext().chatId !== chatIdSnap) return;
    if (!response || response.length < 20) return;

    m.L1.push({ range, text: response.trim(), ts: Date.now(), builtFrom: entries.length });
    m.L1.sort((a, b) => parseInt(a.range[0], 10) - parseInt(b.range[0], 10));
}

// ─── Health report ───────────────────────────────────────────────────────────
export function getHealthReport() {
    const m = meta();
    const groups = getStableGroups();
    const floors = getAiFloors();
    const totalGroups = groups.length;

    let withL0 = 0, permaFailed = 0, pending = 0, strippedEmpty = 0;
    for (const g of groups) {
        if (m.L0[g.key] && m.L0[g.key].hash === groupHash(g)) withL0++;
        else if (m.failed[g.key]?.stripped) strippedEmpty++;
        else if (m.failed[g.key]?.count >= 3) permaFailed++;
        else pending++;
    }

    return {
        totalAi     : floors.length,
        totalGroups : totalGroups,
        withL0      : withL0,
        pending     : pending,
        permaFailed : permaFailed,
        strippedEmpty: strippedEmpty,
        l1Chapters  : m.L1.length,
        latestFloorPending: floors.length > 0,   // the very latest AI floor is ALWAYS pending by design
        paused      : m.system.paused,
        lastError   : m.system.lastError,
        busy        : _running || _queue.length > 0,
    };
}

export function isMemoryBusy() { return _running || _queue.length > 0; }

// Returns the migration notice ONCE (then clears it) so callers can surface a
// toast/popup. Shape: { fromVersion, l0Count, l1Count, ts } or null.
// Safe to call repeatedly; only the first call after a schema upgrade returns
// a non-null value.
export function consumeMigrationNotice() {
    const m = meta();
    const notice = m._migration || null;
    if (notice) {
        delete m._migration;
        persist();
    }
    return notice;
}

// ─── Memory context for injection ────────────────────────────────────────────
export function getMemoryContext() {
    if (_getSettings().useBaiBaiBook) return '';
    const m = meta();
    const parts = [];
    if (m.L1.length) {
        parts.push('━ Chương đầu ━');
        for (const l1 of m.L1) {
            parts.push(`[Tầng ${l1.range[0]} - ${l1.range[1]}]\n${l1.text}`);
        }
    }
    // Recent L0 (not yet compressed into L1)
    const groups = getStableGroups();
    const lastL1End = m.L1.length ? parseInt(m.L1[m.L1.length - 1].range[1], 10) : -1;
    const recent = groups
        .filter(g => parseInt(g.floors[0].mesid, 10) > lastL1End)
        .filter(g => m.L0[g.key])
        .slice(-6);
    if (recent.length) {
        parts.push('━ Diễn biến gần đây ━');
        for (const g of recent) {
            const l0 = m.L0[g.key];
            parts.push(`[Tầng ${l0.range[0]} - ${l0.range[1]}]\n${l0.text}`);
        }
    }
    return parts.join('\n\n');
}

// ─── Fill missing ────────────────────────────────────────────────────────────
export async function fillMissing(onProgress) {
    const m = meta();
    m.system.paused = false;
    m.system.consecutiveFails = 0;

    const groups = getStableGroups();
    const targets = [];
    for (const g of groups) {
        const cur = m.L0[g.key];
        if (cur && cur.hash === groupHash(g)) continue;
        if (m.failed[g.key]?.count >= 3) delete m.failed[g.key];
        targets.push(g.key);
    }

    if (!targets.length) {
        onProgress?.({ current: 0, total: 0, done: true });
        return;
    }
    for (let i = 0; i < targets.length; i++) {
        if (_abortController?.signal.aborted) break;
        await runL0(targets[i]);
        onProgress?.({ current: i + 1, total: targets.length, done: false });
        persist();
    }
    maybeQueueL1();
    onProgress?.({ current: targets.length, total: targets.length, done: true });
}

// ─── Rebuild all ─────────────────────────────────────────────────────────────
export async function rebuildAll(onProgress) {
    _abortController = new AbortController();
    const m = meta();
    m.L0 = {}; m.L1 = []; m.failed = {};
    m.system = { paused: false, consecutiveFails: 0, lastError: null };
    persist();

    const groups = getStableGroups();
    for (let i = 0; i < groups.length; i++) {
        if (_abortController.signal.aborted) {
            onProgress?.({ current: i, total: groups.length, aborted: true });
            break;
        }
        await runL0(groups[i].key);
        onProgress?.({ current: i + 1, total: groups.length });
        persist();
    }
    // L1
    const l0Keys = getStableGroups().map(g => g.key).filter(k => m.L0[k]);
    const M = Math.max(2, +_getSettings().memoryL1Group || 10);
    for (let s = 0; s + M <= l0Keys.length; s += M) {
        if (_abortController.signal.aborted) break;
        const chunk = l0Keys.slice(s, s + M);
        const range = [m.L0[chunk[0]].range[0], m.L0[chunk[chunk.length - 1]].range[1]];
        await runL1(range);
        persist();
    }
    onProgress?.({ current: groups.length, total: groups.length, done: true });
    _abortController = null;
}

export function abortRebuild() { _abortController?.abort(); }

// ─── Event handlers ──────────────────────────────────────────────────────────
function onCharacterMessageRendered() {
    if (_getSettings().useBaiBaiBook) return;
    if (!_getSettings().memoryEnabled) return;
    if (meta().system.paused) return;
    // A new AI floor arrived: any stable group (not the newest) whose L0 is missing
    // gets queued. Delay-by-one is baked into getStableGroups().
    const m = meta();
    const groups = getStableGroups();
    for (const g of groups) {
        const cur = m.L0[g.key];
        if (cur && cur.hash === groupHash(g)) continue;
        if (m.failed[g.key]?.count >= 3) continue;
        enqueue({ type: 'L0', groupKey: g.key });
    }
}

function onMessageMutated(mesId) {
    if (_getSettings().useBaiBaiBook) return;
    // Any mutation invalidates any L0 whose range contains this mesid
    const m = meta();
    const midNum = parseInt(String(mesId), 10);
    let dirty = false;
    for (const [k, l0] of Object.entries(m.L0)) {
        const s = parseInt(l0.range[0], 10);
        const e = parseInt(l0.range[1], 10);
        if (midNum >= s && midNum <= e) {
            delete m.L0[k];
            dirty = true;
        }
    }
    if (dirty) {
        // Any L1 whose range contains this mesid is also stale
        m.L1 = m.L1.filter(l1 => {
            const s = parseInt(l1.range[0], 10);
            const e = parseInt(l1.range[1], 10);
            return !(midNum >= s && midNum <= e);
        });
        persist();
    }
}

function onChatChanged() {
    if (_getSettings().useBaiBaiBook) return;
    _queue = [];
    _abortController?.abort();
    _abortController = null;
    // Cancel any in-flight summary fetch — result would land in wrong chat's metadata
    _jobAbortController?.abort();
    _jobAbortController = new AbortController();
}

// ─── Public init ─────────────────────────────────────────────────────────────
// Handles for idempotent (un)registration
const _listeners = { char: null, swipe: null, edit: null, del: null, chat: null };

export function initMemory({ getSettings, callApi }) {
    _getSettings = getSettings || _getSettings;
    _callApi = callApi;
    _jobAbortController = new AbortController();

    // Idempotent (un)register — hot reload / double init won't stack handlers
    const off = (evt, fn) => { if (fn) eventSource.removeListener?.(evt, fn); };
    off(event_types.CHARACTER_MESSAGE_RENDERED, _listeners.char);
    off(event_types.MESSAGE_SWIPED, _listeners.swipe);
    off(event_types.MESSAGE_EDITED, _listeners.edit);
    off(event_types.MESSAGE_DELETED, _listeners.del);
    off(event_types.CHAT_CHANGED, _listeners.chat);

    _listeners.char = onCharacterMessageRendered;
    _listeners.swipe = onMessageMutated;
    _listeners.edit = onMessageMutated;
    _listeners.del = () => {
        if (_getSettings().useBaiBaiBook) return;
        const m = meta();
        const chat = getChat();
        const validMids = new Set(chat.map((_, i) => String(i)));
        for (const [k, l0] of Object.entries(m.L0)) {
            if (!validMids.has(l0.range[0]) || !validMids.has(l0.range[1])) delete m.L0[k];
        }
        m.L1 = m.L1.filter(l1 => validMids.has(l1.range[0]) && validMids.has(l1.range[1]));
        persist();
    };
    _listeners.chat = onChatChanged;

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _listeners.char);
    eventSource.on(event_types.MESSAGE_SWIPED, _listeners.swipe);
    eventSource.on(event_types.MESSAGE_EDITED, _listeners.edit);
    eventSource.on(event_types.MESSAGE_DELETED, _listeners.del);
    eventSource.on(event_types.CHAT_CHANGED, _listeners.chat);
}

export function resumeSystem() {
    const m = meta();
    m.system.paused = false;
    m.system.consecutiveFails = 0;
    m.system.lastError = null;
    persist();
}
