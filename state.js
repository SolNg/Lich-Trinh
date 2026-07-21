function normalizeScopePart(value, fallback = 'default') {
    const text = String(value ?? '').trim();
    return text ? encodeURIComponent(text) : fallback;
}

// One shared cache key builder — historical per-kind builders below delegate here.
// Format: sp-cache-{chatId}-{kind}-{user | char-<name>}
function buildCacheKey(chatId, kind, view = 'user', charName = '') {
    if (!chatId) return null;
    const scope = (view === 'char' && charName)
        ? `char-${normalizeScopePart(charName)}`
        : 'user';
    // 'schedule' is the original bare kind ('sp-cache-{chatId}-user'), keep that
    // shape for backward compat with existing localStorage entries.
    return kind === 'schedule'
        ? `sp-cache-${chatId}-${scope}`
        : `sp-cache-${chatId}-${kind}-${scope}`;
}

export function buildScheduleCacheKey(chatId, view = 'user', charName = '') {
    return buildCacheKey(chatId, 'schedule', view, charName);
}

export function buildOutlineCacheKey(chatId, view = 'user', charName = '') {
    return buildCacheKey(chatId, 'outline', view, charName);
}

export function buildStorylinesCacheKey(chatId, view = 'user', charName = '') {
    return buildCacheKey(chatId, 'lines', view, charName);
}

export function buildCreativeChatHistoryKey(chatId, view = 'user', charName = '') {
    return buildCacheKey(chatId, 'creative-chat', view, charName);
}

export function buildSpaceChatHistoryKey(chatId, view = 'user', charName = '') {
    return buildCacheKey(chatId, 'space-chat', view, charName);
}

export function getCreativeChatPlaceholder() {
    return 'Cùng AI bàn về cốt truyện, đại cương hoặc thiết định…';
}

export function getSpaceChatPlaceholder() {
    return 'Trò chuyện ngoài lề: cốt truyện, thiết định, mối quan hệ, kiến thức…';
}

export function buildCreativeChatSystemPrompt({ userName, charName, outlineRaw = '', wiContext = '' }) {
    const outlineSection = outlineRaw
        ? `\nĐại cương hiện tại:\n${outlineRaw}\n`
        : '\nHiện chưa có đại cương chính thức, có thể bắt đầu bàn từ ý tưởng, hướng đi cốt truyện, mối quan hệ nhân vật, thiết định nhân vật hoặc ý tưởng thế giới quan.\n';

    return [
        `Bạn là một cố vấn sáng tác truyện, đang giúp người dùng cùng ${charName} bàn về diễn biến câu chuyện giữa ${userName} và ${charName}.${outlineSection}`,
        wiContext,
        'Hãy trả lời với vai trò cố vấn sáng tác, không nhập vai bất kỳ nhân vật nào. Mặc định ưu tiên xoay quanh diễn biến cốt truyện, bổ sung thiết định, mối quan hệ nhân vật và gợi mở ý tưởng để phản hồi. Chỉ khi người dùng yêu cầu rõ ràng bạn "viết đại cương" hoặc yêu cầu xuất đại cương, mới xuất đại cương mới đầy đủ và bọc trong <outline_widget>...</outline_widget>; những lúc khác không xuất thẻ <outline_widget>.',
    ].filter(Boolean).join('\n');
}

export function buildSpaceChatSystemPrompt({ userName, charName, outlineRaw = '', wiContext = '', memText = '' }) {
    const parts = [
        `Bạn là một cố vấn sáng tác kiêm trợ lý kiến thức am hiểu mọi lĩnh vực, trò chuyện cùng người dùng bên ngoài câu chuyện giữa ${userName} và ${charName} (phần "trò chuyện ngoài lề").`,
        `Ở đây không đẩy tiếp cốt truyện, không nhập vai bất kỳ nhân vật nào, chỉ trả lời câu hỏi của người dùng — bao gồm nhưng không giới hạn ở hướng đi cốt truyện, khảo cứu thiết định, suy luận mối quan hệ nhân vật, tính khả thi của hướng phát triển, kỹ thuật sáng tác, cũng như kiến thức đời thực như lịch sử, trang phục, địa lý, phong tục, khoa học...`,
        outlineRaw ? `\n【Diện hiện tại (đại cương)】\n${outlineRaw}` : '',
        wiContext,
        memText ? `\n【Ký ức câu chuyện】\n${memText}` : '',
        `\nHãy trả lời trực tiếp câu hỏi của người dùng bằng giọng điệu cố vấn. Không xuất các thẻ cấu trúc như <outline_widget>.`,
    ];
    return parts.filter(Boolean).join('\n');
}
