// automation-gate.js — cổng tiếp quản việc tự cập nhật theo tầng
//
// Luồng công việc tường minh có thể khai báo "ở tầng này, những module tự động nào do tôi tiếp quản". Mỗi module chỉ hỏi
// xem chính nó có đang bị tiếp quản hay không, không cần biết quy trình nghiệp vụ cụ thể. Cổng này chỉ giữ trạng thái trong bộ nhớ, không sửa bộ đếm của bất kỳ module nào.

export function createAutomationGate() {
    const claims = new Map();
    let claimSeq = 0;

    function claim({ scopeId, messageId, modules } = {}) {
        const scopeKey = String(scopeId ?? '').trim();
        const mid = Number(messageId);
        if (!scopeKey || !Number.isInteger(mid) || !Array.isArray(modules)) return null;
        const names = new Set(modules.map(value => String(value || '').trim()).filter(Boolean));
        if (!names.size) return null;
        const token = Object.freeze({ id: ++claimSeq });
        claims.set(token, { scopeId: scopeKey, messageId: mid, modules: names });
        return token;
    }

    function isSuppressed({ scopeId, messageId, module: moduleName } = {}) {
        const scopeKey = String(scopeId ?? '').trim();
        const mid = Number(messageId);
        const name = String(moduleName || '').trim();
        if (!scopeKey || !Number.isInteger(mid) || !name) return false;
        for (const record of claims.values()) {
            if (record.scopeId === scopeKey && record.messageId === mid && record.modules.has(name)) return true;
        }
        return false;
    }

    function release(token) {
        return claims.delete(token);
    }

    function clear() {
        claims.clear();
    }

    return Object.freeze({ claim, isSuppressed, release, clear });
}
