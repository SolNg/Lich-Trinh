export const TIME_TRAVEL_MARKER = '[Thay đổi thời gian]';
export const TIME_TRAVEL_BLOCK_OPEN = '<time-change>';
export const TIME_TRAVEL_BLOCK_CLOSE = '</time-change>';

// Ghép cặp theo ngăn xếp giúp lớp trong còn nguyên vẹn vẫn nhận ra được dù lớp ngoài bị khuyết; thẻ không ghép được cặp thì nhất loạt giữ lại như văn bản của người dùng.
export function findTimeTravelBlocks(value) {
    const text = String(value ?? '');
    const stack = [];
    const ranges = [];
    let cursor = 0;
    while (cursor < text.length) {
        const openAt = text.indexOf(TIME_TRAVEL_BLOCK_OPEN, cursor);
        const closeAt = text.indexOf(TIME_TRAVEL_BLOCK_CLOSE, cursor);
        if (openAt < 0 && closeAt < 0) break;
        if (openAt >= 0 && (closeAt < 0 || openAt < closeAt)) {
            stack.push(openAt);
            cursor = openAt + TIME_TRAVEL_BLOCK_OPEN.length;
            continue;
        }
        const start = stack.pop();
        const end = closeAt + TIME_TRAVEL_BLOCK_CLOSE.length;
        if (Number.isInteger(start)) ranges.push({ start, end });
        cursor = end;
    }
    return ranges.sort((a, b) => a.start - b.start || b.end - a.end);
}

export function hasTimeTravelBlock(value) {
    return findTimeTravelBlocks(value).length > 0;
}

export function removeTimeTravelBlocks(value) {
    const text = String(value ?? '');
    const ranges = findTimeTravelBlocks(text);
    if (!ranges.length) return text;
    const merged = [];
    for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
        else merged.push({ ...range });
    }
    let result = '';
    let cursor = 0;
    for (const range of merged) {
        result += text.slice(cursor, range.start);
        cursor = range.end;
    }
    return result + text.slice(cursor);
}

export const TIME_TRAVEL_DIRECTION_OPTIONS = Object.freeze([
    Object.freeze({ value: 'none', label: 'Không chỉ định', prompt: '' }),
    Object.freeze({ value: 'daily', label: 'Đời thường', prompt: 'đời thường' }),
    Object.freeze({ value: 'growth', label: 'Trưởng thành', prompt: 'trưởng thành' }),
    Object.freeze({ value: 'sweet', label: 'Ngọt ngào', prompt: 'ngọt ngào' }),
    Object.freeze({ value: 'angst', label: 'Bi kịch', prompt: 'bi kịch, giằng xé' }),
    Object.freeze({ value: 'custom', label: 'Tự định nghĩa', prompt: '', custom: true }),
]);

function cleanDate(value) {
    const month = Number(value?.month);
    const day = Number(value?.day);
    if (!Number.isInteger(month) || month < 1 || !Number.isInteger(day) || day < 1) return null;
    return { month, day };
}

export function sameMonthDay(a, b) {
    const left = cleanDate(a);
    const right = cleanDate(b);
    return !!left && !!right && left.month === right.month && left.day === right.day;
}

export function formatTravelDate(date, calendar) {
    const md = cleanDate(date);
    if (!md) return '';
    const name = String(calendar?.months?.[md.month - 1]?.name || `tháng ${md.month}`).trim() || `tháng ${md.month}`;
    const month = name === `tháng ${md.month}` ? name : `${name} (tháng thứ ${md.month})`;
    return `ngày ${md.day} ${month}`;
}

// Việc xét ngày kỷ niệm trải qua nhiều tháng, nhiều năm và vị trí trong khoảng vẫn do các thuật toán sẵn có của module Lịch lo; module này chỉ sắp xếp lại những trường mà chính văn cần.
export function collectTravelAnniversaries(items, targetDate, calendar, resolveCoverage, resolveTypeLabel) {
    const md = cleanDate(targetDate);
    if (!md || !Array.isArray(items) || typeof resolveCoverage !== 'function' || typeof resolveTypeLabel !== 'function') return [];
    return items.map(item => {
        const coverage = resolveCoverage(item, md, calendar);
        if (!coverage) return null;
        const startDate = cleanDate(coverage.startDate || item);
        const endDate = cleanDate(coverage.endDate || item);
        const days = Math.max(1, Number.parseInt(coverage.days ?? item?.days, 10) || 1);
        const dayIndex = Math.min(days, Math.max(1, Number.parseInt(coverage.dayIndex, 10) || 1));
        return {
            name: String(item?.name || '').trim(),
            type: String(resolveTypeLabel(item?.type, item) || '').trim(),
            days,
            dayIndex,
            startDate,
            endDate,
            displayDate: String(item?.displayDate || '').trim(),
            note: String(item?.note || '').trim(),
        };
    }).filter(item => item?.name && item.startDate && item.endDate);
}

export function buildTravelAnniversaryText(item, calendar, weekday = '') {
    const start = formatTravelDate(item?.startDate, calendar);
    const end = formatTravelDate(item?.endDate, calendar);
    const days = Math.max(1, Number.parseInt(item?.days, 10) || 1);
    const dayIndex = Math.min(days, Math.max(1, Number.parseInt(item?.dayIndex, 10) || 1));
    const details = [String(item?.type || '').trim()].filter(Boolean);
    const displayDate = String(item?.displayDate || '').trim();
    if (displayDate) details.push(displayDate);
    if (String(weekday || '').trim()) details.push(String(weekday).trim());
    if (days > 1) {
        details.push(`bắt đầu ${start}`, `kết thúc ${end}`, `kéo dài ${days} ngày`, `ngày đích là ngày thứ ${dayIndex}`);
    }
    const note = String(item?.note || '').trim();
    return `${String(item?.name || '').trim()} (${details.join(', ')})${note ? `: ${note}` : ''}`;
}

export function buildTravelNarrativeInstruction({ linesInjected = false, outlineInjected = false, ledgerInjected = false } = {}) {
    const instructions = [
        '- Cảnh chính của phần nội dung diễn ra vào ngày ở điểm cuối thời gian; phần diễn biến ở giữa nếu cần thì nhiều nhất chỉ tóm tắt trong một đoạn ngắn ở đầu, đừng kể lần lượt từng ngày hay chia giai đoạn cho cả khoảng thời gian tính từ điểm đầu.',
    ];
    const injected = [];
    if (linesInjected) injected.push('mạch ngầm');
    if (outlineInjected) injected.push('đại cương cốt truyện');
    if (ledgerInjected) injected.push('sổ thời gian');
    if (injected.length) {
        instructions.push(`- Trạng thái hiện tại của ${injected.join(', ')} là trạng thái ở điểm đầu thời gian hoặc trước đó, chứ không phải trạng thái mới tại điểm cuối thời gian.`);
    }
    return instructions.join('\n');
}

export function buildTravelStoryPrompt({ sourceDate, targetDate, direction = '', anniversaries = [], calendar, targetWeekday = '', injectionState = {} } = {}) {
    const lines = [
        TIME_TRAVEL_BLOCK_OPEN,
        TIME_TRAVEL_MARKER,
        '',
        `Điểm đầu thời gian: ${formatTravelDate(sourceDate, calendar)}`,
        `Điểm cuối thời gian: ${formatTravelDate(targetDate, calendar)}`,
    ];
    if (anniversaries.length) {
        lines.push('', '[Ngày hôm đó]');
        for (const item of anniversaries) {
            lines.push(`- ${buildTravelAnniversaryText(item, calendar, targetWeekday)}`);
        }
    }
    if (String(direction || '').trim()) lines.push('', `Hướng cốt truyện: ${String(direction).trim()}`);
    lines.push('', buildTravelNarrativeInstruction(injectionState));
    lines.push('Hãy kết hợp cốt truyện hiện tại, trạng thái nhân vật và thông tin ngày tháng ở trên để viết tiếp một cách tự nhiên phần cốt truyện sau khi thời gian thay đổi.');
    lines.push(TIME_TRAVEL_BLOCK_CLOSE);
    return lines.join('\n');
}

export function buildTravelPromptAddon({ sourceDate, destinationDate, direction = '', calendar } = {}) {
    const lines = [
        '[Lần thay đổi thời gian này]',
        `Điểm đầu thời gian: ${formatTravelDate(sourceDate, calendar)}`,
        `Điểm cuối thời gian: ${formatTravelDate(destinationDate, calendar)}`,
    ];
    if (String(direction || '').trim()) lines.push(`Hướng cốt truyện: ${String(direction).trim()}`);
    lines.push('', 'Phần trên dùng để nói rõ phạm vi thời gian và hướng cốt truyện của lần viết này.');
    return lines.join('\n');
}

export function buildTravelPlanningContext({ outline = [], outlineCursor = 1, lines = [] } = {}) {
    const blocks = [];
    if (Array.isArray(outline) && outline.length) {
        const cursor = Number.isFinite(Number(outlineCursor)) ? Math.floor(Number(outlineCursor)) : 1;
        blocks.push(`[Quy hoạch đại cương cốt truyện]\n${outline.map((beat, index) => {
            const current = index + 1 === cursor ? ' (nút hiện tại)' : '';
            const head = `${index + 1}${current}. ${beat?.time ? `${beat.time} · ` : ''}${beat?.title || 'Nút chưa đặt tên'}`;
            const details = [beat?.type, beat?.scene, beat?.outcome].filter(Boolean).join('; ');
            return `${head}${details ? `\n   ${details}` : ''}`;
        }).join('\n')}`);
    }
    if (Array.isArray(lines) && lines.length) {
        blocks.push(`[Tuyến sự kiện tham khảo]\n${lines.map((line, index) => {
            const meta = [line?.type, line?.stage, line?.when, line?.agency, line?.stall ? 'đang đình trệ' : 'đang đẩy tiến'].filter(Boolean).join(' / ');
            return `${index + 1}. ${line?.name || 'Tuyến sự kiện chưa đặt tên'}${meta ? ` (${meta})` : ''}${line?.desc ? `\n   Hiện trạng: ${line.desc}` : ''}${line?.next ? `\n   Bước tiếp theo: ${line.next}` : ''}`;
        }).join('\n')}`);
    }
    return blocks.join('\n\n');
}

export function buildTravelDirectionPrompt({ sourceDate, targetDate, anniversaries = [], calendar, targetWeekday = '', preference = '', excluded = [], outline = [], outlineCursor = 1, lines = [] } = {}) {
    const planningBlock = buildTravelPlanningContext({ outline, outlineCursor, lines });
    const planningNames = [];
    if (Array.isArray(outline) && outline.length) planningNames.push('đại cương cốt truyện');
    if (Array.isArray(lines) && lines.length) planningNames.push('tuyến sự kiện');
    const planningRule = planningNames.length
        ? `Hướng suy diễn diễn ra vào ngày ở điểm cuối thời gian của nhiệm vụ suy diễn lần này. Trạng thái hiện tại của ${planningNames.join(' và ')} là trạng thái ở điểm đầu thời gian hoặc trước đó, chứ không phải trạng thái mới tại điểm cuối thời gian.`
        : 'Hướng suy diễn diễn ra vào ngày ở điểm cuối thời gian của nhiệm vụ suy diễn lần này.';
    const preferenceText = String(preference || '').trim();
    const preferenceBlock = preferenceText
        ? `Hướng suy diễn mà người dùng ưa thích: ${preferenceText}`
        : '';
    const excludedBlock = Array.isArray(excluded) && excluded.length
        ? `\n[Những hướng đã trình bày trong lần này]\n${excluded.map((item, index) => `${index + 1}. ${String(item || '').trim()}`).join('\n')}\nKết quả mới không được lặp lại hay viết lại diễn giải các hướng trên.`
        : '';
    const anniversaryBlock = Array.isArray(anniversaries) && anniversaries.length
        ? `\n[Ngày của ngày đích]\n${anniversaries.map(item => `- ${buildTravelAnniversaryText(item, calendar, targetWeekday)}`).join('\n')}`
        : '';
    return `Hãy dựa vào cốt truyện hiện tại, suy diễn trước ba hướng cốt truyện khác biệt rõ ràng, dùng được ngay để viết tiếp, cho một lần thay đổi thời gian.
${planningBlock ? `\n${planningBlock}\n` : ''}
[Nhiệm vụ suy diễn]
Điểm đầu thời gian: ${formatTravelDate(sourceDate, calendar)}
Điểm cuối thời gian: ${formatTravelDate(targetDate, calendar)}${anniversaryBlock}
${preferenceBlock ? `${preferenceBlock}\n` : ''}${excludedBlock}

[Quy tắc suy diễn]
1. ${planningRule}
2. Chỉ nghĩ hướng đi cho ngày sau khi thời gian đã thay đổi như trên, bắt buộc xuất ra đúng ba hướng, mỗi hướng 40—80 chữ, mỗi dòng một hướng; chỉ nói rõ xung đột cốt lõi, lựa chọn của nhân vật và khả năng phát triển, không triển khai cảnh đầy đủ hay hành động cụ thể, không viết thẳng phần nội dung, không giải thích hay lặp lại.`;
}

export function parseTravelDirections(raw, excluded = []) {
    const old = new Set((Array.isArray(excluded) ? excluded : []).map(item => String(item || '').trim()).filter(Boolean));
    const seen = new Set();
    const out = [];
    for (const line of String(raw || '').split('\n')) {
        const text = line.trim().replace(/^[-*•\s]+/, '').replace(/^\d+[.、)）]\s*/, '').trim();
        if (!text || old.has(text) || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
        if (out.length >= 3) break;
    }
    return out;
}

// Chỉ nhận tầng AI mới nhất và tầng người dùng hợp lệ gần nhất trước đó; tin nhắn hệ thống có thể kẹp giữa hai tầng ấy.
export function findTravelReply(chat, messageId) {
    if (!Array.isArray(chat)) return null;
    const mid = Number(messageId);
    if (!Number.isInteger(mid) || mid !== chat.length - 1) return null;
    const reply = chat[mid];
    if (!reply || reply.is_user || reply.is_system) return null;
    let userId = mid - 1;
    while (userId >= 0 && chat[userId]?.is_system) userId--;
    const user = chat[userId];
    if (!user?.is_user || !hasTimeTravelBlock(user.mes)) return null;
    return { messageId: mid, userMessageId: userId };
}

// Bộ điều khiển chỉ giữ trạng thái trong bộ nhớ và thứ tự thực thi của một phiên; còn API, lưu trữ, giao diện và thông báo cụ thể thì bên gọi tự thích ứng.
export function createTimeTravelController({ getChatId, getChat, resolveDestinationDate, getCalendar, onStateChange, onStepResult, onSequenceEnd, steps = [] } = {}) {
    let state = null;
    let sequenceAbort = null;
    let sessionSeq = 0;

    const snapshot = () => state ? { ...state, sourceDate: { ...state.sourceDate }, selectedTargetDate: { ...state.selectedTargetDate } } : null;
    const reportState = reason => {
        try { onStateChange?.({ state: snapshot(), reason }); }
        catch (error) { console.error('[SP Du hành thời gian] Làm mới trạng thái thất bại', error); }
    };

    function begin({ chatId, sourceDate, selectedTargetDate, direction = '' } = {}) {
        const source = cleanDate(sourceDate);
        const target = cleanDate(selectedTargetDate);
        if (!chatId || !source || !target) return false;
        sequenceAbort?.abort();
        sequenceAbort = null;
        const chat = getChat?.();
        state = {
            phase: 'waiting',
            sessionId: ++sessionSeq,
            chatId,
            waitingAfterMessageId: Array.isArray(chat) ? chat.length - 1 : -1,
            sourceDate: source,
            selectedTargetDate: target,
            direction: String(direction || '').trim(),
        };
        reportState('waiting');
        return true;
    }

    function clear() {
        const hadState = !!state;
        sequenceAbort?.abort();
        sequenceAbort = null;
        state = null;
        if (hadState) reportState('cleared');
    }

    function isInitialFloor(messageId) {
        if (state?.phase !== 'waiting' || state.chatId !== getChatId?.()) return false;
        const reply = findTravelReply(getChat?.(), messageId);
        return !!reply
            && reply.messageId > state.waitingAfterMessageId
            && reply.userMessageId > state.waitingAfterMessageId;
    }

    async function handleRendered(messageId) {
        if (!isInitialFloor(messageId)) {
            const chat = getChat?.();
            const mid = Number(messageId);
            const latest = Array.isArray(chat) && Number.isInteger(mid) && mid === chat.length - 1 && !chat[mid]?.is_user && !chat[mid]?.is_system;
            if (state?.phase === 'waiting'
                && state.chatId === getChatId?.()
                && latest
                && mid > state.waitingAfterMessageId) {
                state = null;
                reportState('cancelled');
            }
            return false;
        }
        const active = state;
        active.phase = 'syncing';
        reportState('syncing');
        const myAbort = sequenceAbort = new AbortController();
        try {
            const destinationDate = cleanDate(await resolveDestinationDate?.({
                messageId: Number(messageId),
                chatId: active.chatId,
                sourceDate: active.sourceDate,
                selectedTargetDate: active.selectedTargetDate,
                signal: myAbort.signal,
            }));
            if (!destinationDate) throw new Error('Không đọc được mốc ngày sau khi sinh nội dung');
            const calendar = getCalendar?.();
            const promptAddon = buildTravelPromptAddon({
                sourceDate: active.sourceDate,
                destinationDate,
                direction: active.direction,
                calendar,
            });
            for (const step of steps) {
                if (myAbort.signal.aborted) break;
                let result = { status: 'skipped' };
                try {
                    result = await step.run({
                        messageId: Number(messageId),
                        destinationDate,
                        promptAddon,
                    }) || { status: 'skipped' };
                } catch (error) {
                    try { step.onError?.(error); }
                    catch (reportError) { console.error('[SP Du hành thời gian] Xử lý lỗi của bước thất bại', reportError); }
                    result = { status: error?.name === 'AbortError' ? 'cancelled' : 'failed', error };
                }
                try {
                    await onStepResult?.({ key: step.key || '', result, messageId: Number(messageId), destinationDate });
                } catch (error) {
                    console.error('[SP Du hành thời gian] Xử lý kết quả của bước thất bại', error);
                }
            }
        } finally {
            if (sequenceAbort === myAbort) sequenceAbort = null;
            if (state === active) {
                state = null;
                reportState('completed');
            }
            try {
                await onSequenceEnd?.({ messageId: Number(messageId), chatId: active.chatId, sessionId: active.sessionId });
            } catch (error) {
                console.error('[SP Du hành thời gian] Kết thúc quy trình thất bại', error);
            }
        }
        return true;
    }

    return Object.freeze({ begin, clear, getState: snapshot, isInitialFloor, handleRendered });
}
