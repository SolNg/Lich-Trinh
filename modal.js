const OVERLAY_ID = 'sp-addon-dialog';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeTextareaRows(value) {
    const rows = Math.floor(Number(value));
    return Number.isFinite(rows) ? Math.min(12, Math.max(1, rows)) : 3;
}

// Hộp thoại quyết định dùng chung chỉ lo lớp che và vòng đời Promise của chính nó; phần phán đoán nghiệp vụ và lưu trữ để bên gọi tự làm.
// removeOverlay (không bắt buộc): tiêm sẵn cách "gỡ overlay đang tồn tại" — sau khi vật chủ dời vào shadow thì
// $() của light DOM không tìm ra overlay nữa, nên bên gọi phải tự cung cấp (ví dụ () => $in('#sp-addon-dialog').remove()).
export function createDialogManager({ $, mount, getRootClass = () => '', subscribeContextChange = () => () => {}, removeOverlay = null } = {}) {
    if (typeof $ !== 'function' || !mount?.appendChild) throw new TypeError('Trình quản lý hộp thoại thiếu phụ thuộc DOM');
    const purgeOverlay = removeOverlay || (() => $(`#${OVERLAY_ID}`).remove());

    let activeCancel = null;

    function cancelActive() {
        if (!activeCancel) return false;
        activeCancel();
        return true;
    }

    function prepareDialog() {
        cancelActive();
        purgeOverlay();
    }

    // Mọi hộp thoại dùng chung một bộ ngữ nghĩa đóng, tránh việc một API nào đó quên dọn lớp che, quên Esc hoặc quên dọn khi đổi cuộc trò chuyện.
    function mountDialog($overlay, resolve, { onClose } = {}) {
        let done = false;
        let unsubscribe = () => {};
        const finish = value => {
            if (done) return false;
            done = true;
            if (activeCancel === externalClose) activeCancel = null;
            try { onClose?.(); }
            finally {
                unsubscribe();
                $overlay.remove();
                resolve(value);
            }
            return true;
        };
        const externalClose = () => finish(null);
        activeCancel = externalClose;
        $overlay.on('click', function (event) { if (event.target === this) externalClose(); });
        $overlay.on('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            externalClose();
        });
        $overlay.addClass(String(getRootClass() || ''));
        mount.appendChild($overlay[0]);
        unsubscribe = subscribeContextChange(externalClose) || (() => {});
        return Object.freeze({ finish, close: externalClose, isDone: () => done });
    }

    function choose({ title = '', body = '', note = '', choices = [] } = {}) {
        if (!Array.isArray(choices) || !choices.length) return Promise.resolve(null);
        return new Promise(resolve => {
            prepareDialog();
            const buttons = choices.map((choice, index) => {
                const tone = choice.primary ? 'primary' : 'secondary';
                return `<button class="sp-dialog-button sp-dialog-button-${tone}" type="button" data-dialog-choice="${index}">${escapeHtml(choice.label)}</button>`;
            }).join('');
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay">
                <div class="sp-dialog-sheet" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title">
                    <div id="sp-dialog-title" class="sp-dialog-head">${escapeHtml(title)}</div>
                    <div class="sp-dialog-body">${escapeHtml(body)}</div>
                    ${note ? `<div class="sp-dialog-note">${escapeHtml(note)}</div>` : ''}
                    <div class="sp-dialog-actions">${buttons}</div>
                </div>
            </div>`);
            const session = mountDialog($overlay, resolve);
            $overlay.find('[data-dialog-choice]').on('click', function () {
                const choice = choices[Number($(this).attr('data-dialog-choice'))];
                session.finish(choice?.value ?? null);
            });
            setTimeout(() => $overlay.find('[data-dialog-choice]').last().trigger('focus'), 0);
        });
    }

    function confirm({ title, body, note, confirmText = 'Đồng ý', cancelText = 'Hủy' } = {}) {
        return choose({
            title,
            body,
            note,
            choices: [
                { value: 'cancel', label: cancelText },
                { value: 'confirm', label: confirmText, primary: true },
            ],
        }).then(value => value === 'confirm');
    }

    function prompt({ title = '', body = '', initialValue = '', placeholder = '', maxLength = 40, confirmText = 'Lưu', cancelText = 'Hủy', validate } = {}) {
        return new Promise(resolve => {
            prepareDialog();
            const limit = Number(maxLength) > 0 ? Number(maxLength) : 40;
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay">
                <div class="sp-dialog-sheet" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title">
                    <div id="sp-dialog-title" class="sp-dialog-head">${escapeHtml(title)}</div>
                    ${body ? `<div class="sp-dialog-body">${escapeHtml(body)}</div>` : ''}
                    <input type="text" class="sp-dialog-input" value="${escapeHtml(initialValue)}" placeholder="${escapeHtml(placeholder)}" maxlength="${limit}" autocomplete="off">
                    <div class="sp-dialog-input-error" aria-live="polite"></div>
                    <div class="sp-dialog-actions">
                        <button class="sp-dialog-button sp-dialog-button-secondary sp-dialog-cancel" type="button">${escapeHtml(cancelText)}</button>
                        <button class="sp-dialog-button sp-dialog-button-primary sp-dialog-submit" type="button">${escapeHtml(confirmText)}</button>
                    </div>
                </div>
            </div>`);
            const session = mountDialog($overlay, resolve);
            const submit = () => {
                const value = String($overlay.find('.sp-dialog-input').val() ?? '').trim();
                // Quy ước kiểm tra: trả về chuỗi khác rỗng = thông báo lỗi; mọi thứ khác ('' / null / undefined / true / số / object) đều coi là hợp lệ.
                // Cách viết cũ String(validate()||'') sẽ biến true→"true", object→"[object Object]" và hiện nhầm thành lỗi, đồng thời nuốt mất 0/false.
                const raw = typeof validate === 'function' ? validate(value) : '';
                const error = typeof raw === 'string' ? raw : '';
                if (error) {
                    $overlay.find('.sp-dialog-input-error').html(`<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(error)}`);
                    $overlay.find('.sp-dialog-input').trigger('focus');
                    return;
                }
                session.finish(value);
            };
            $overlay.find('.sp-dialog-submit').on('click', submit);
            $overlay.find('.sp-dialog-cancel').on('click', session.close);
            $overlay.find('.sp-dialog-input').on('input', () => $overlay.find('.sp-dialog-input-error').empty()).on('keydown', event => {
                if (event.key === 'Enter') { event.preventDefault(); submit(); }
                else if (event.key === 'Escape') { event.preventDefault(); session.close(); }
            });
            setTimeout(() => $overlay.find('.sp-dialog-input').trigger('focus').trigger('select'), 0);
        });
    }

    // Biểu mẫu nhiều lựa chọn dùng chung: chỉ lo phần loại trừ lẫn nhau giữa các lựa chọn, phần nhập tùy chỉnh và vòng đời; còn danh sách lựa chọn cùng phần kiểm tra nghiệp vụ thì bên gọi cung cấp.
    function selectMany({ title = '', body = '', choices = [], initialValues = [], custom = null, confirmText = 'Đồng ý', cancelText = 'Hủy', validate } = {}) {
        if (!Array.isArray(choices) || !choices.length) return Promise.resolve(null);
        return new Promise(resolve => {
            prepareDialog();
            const initial = new Set((Array.isArray(initialValues) ? initialValues : []).map(String));
            const customValue = custom?.value == null ? '' : String(custom.value);
            const customLimit = Number(custom?.maxLength) > 0 ? Number(custom.maxLength) : 200;
            const customRows = normalizeTextareaRows(custom?.rows);
            const rows = choices.map(choice => {
                const value = String(choice?.value ?? '');
                const checked = initial.has(value) ? ' checked' : '';
                const exclusive = choice?.exclusive ? ' data-dialog-exclusive="true"' : '';
                return `<label class="sp-dialog-multi-option">
                    <input type="checkbox" class="sp-dialog-multi-check" data-dialog-value="${escapeHtml(value)}"${exclusive}${checked}>
                    <span>${escapeHtml(choice?.label ?? value)}</span>
                </label>`;
            }).join('');
            const customInput = customValue
                ? `<textarea class="sp-dialog-custom-input" maxlength="${customLimit}" placeholder="${escapeHtml(custom?.placeholder || '')}" rows="${customRows}"></textarea>`
                : '';
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay">
                <div class="sp-dialog-sheet" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title">
                    <div id="sp-dialog-title" class="sp-dialog-head">${escapeHtml(title)}</div>
                    ${body ? `<div class="sp-dialog-body">${escapeHtml(body)}</div>` : ''}
                    <div class="sp-dialog-multi-list">${rows}</div>
                    ${customInput}
                    <div class="sp-dialog-input-error" aria-live="polite"></div>
                    <div class="sp-dialog-actions">
                        <button class="sp-dialog-button sp-dialog-button-secondary sp-dialog-cancel" type="button">${escapeHtml(cancelText)}</button>
                        <button class="sp-dialog-button sp-dialog-button-primary sp-dialog-submit" type="button">${escapeHtml(confirmText)}</button>
                    </div>
                </div>
            </div>`);
            const session = mountDialog($overlay, resolve);
            const selectedValues = () => {
                const values = [];
                $overlay.find('.sp-dialog-multi-check').each(function () {
                    if ($(this).prop('checked')) values.push(String($(this).attr('data-dialog-value') || ''));
                });
                return values;
            };
            const syncCustomInput = () => {
                if (!customValue) return;
                const on = selectedValues().includes(customValue);
                $overlay.find('.sp-dialog-custom-input').prop('hidden', !on).prop('disabled', !on);
            };
            const submit = () => {
                const values = selectedValues();
                const inputValue = customValue && values.includes(customValue)
                    ? String($overlay.find('.sp-dialog-custom-input').val() ?? '').trim()
                    : '';
                const result = { values, customValue: inputValue };
                const raw = typeof validate === 'function' ? validate(result) : '';
                const error = typeof raw === 'string' ? raw : '';
                if (error) {
                    $overlay.find('.sp-dialog-input-error').html(`<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(error)}`);
                    if (customValue && values.includes(customValue) && !inputValue) $overlay.find('.sp-dialog-custom-input').trigger('focus');
                    return;
                }
                session.finish(result);
            };
            $overlay.find('.sp-dialog-multi-check').on('change', function () {
                const $self = $(this);
                if ($self.prop('checked')) {
                    if ($self.attr('data-dialog-exclusive') === 'true') {
                        $overlay.find('.sp-dialog-multi-check').each(function () { if (this !== $self[0]) $(this).prop('checked', false); });
                    } else {
                        $overlay.find('.sp-dialog-multi-check[data-dialog-exclusive="true"]').prop('checked', false);
                    }
                }
                $overlay.find('.sp-dialog-input-error').empty();
                syncCustomInput();
            });
            $overlay.find('.sp-dialog-custom-input').on('input', () => $overlay.find('.sp-dialog-input-error').empty()).on('keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); session.close(); }
            });
            $overlay.find('.sp-dialog-submit').on('click', submit);
            $overlay.find('.sp-dialog-cancel').on('click', session.close);
            syncCustomInput();
            setTimeout(() => $overlay.find('.sp-dialog-multi-check').first().trigger('focus'), 0);
        });
    }

    // Biểu mẫu một lựa chọn dùng chung: hỗ trợ một ô nhập tùy chỉnh mở rộng được, cùng nhiều hành động gửi do bên gọi định nghĩa.
    function selectOne({ title = '', body = '', choices = [], initialValue = '', custom = null, actions = [], cancelText = 'Hủy', validate } = {}) {
        if (!Array.isArray(choices) || !choices.length || !Array.isArray(actions) || !actions.length) return Promise.resolve(null);
        return new Promise(resolve => {
            prepareDialog();
            let selected = String(initialValue || choices[0]?.value || '');
            const customValue = custom?.value == null ? '' : String(custom.value);
            const customLimit = Number(custom?.maxLength) > 0 ? Number(custom.maxLength) : 200;
            const customInitialValue = String(custom?.initialValue ?? '').slice(0, customLimit);
            const customRows = normalizeTextareaRows(custom?.rows);
            const options = choices.map(choice => {
                const value = String(choice?.value ?? '');
                const pressed = value === selected ? 'true' : 'false';
                return `<button type="button" class="sp-dialog-single-option${value === selected ? ' sp-dialog-single-selected' : ''}" data-dialog-value="${escapeHtml(value)}" aria-pressed="${pressed}">${escapeHtml(choice?.label ?? value)}</button>`;
            }).join('');
            const actionButtons = actions.map((action, index) => {
                const tone = action?.primary ? 'primary' : 'secondary';
                return `<button type="button" class="sp-dialog-button sp-dialog-button-${tone}" data-dialog-action="${index}">${escapeHtml(action?.label ?? '')}</button>`;
            }).join('');
            const customInput = customValue
                ? `<textarea class="sp-dialog-custom-input" maxlength="${customLimit}" placeholder="${escapeHtml(custom?.placeholder || '')}" rows="${customRows}"${selected === customValue ? '' : ' hidden disabled'}></textarea>`
                : '';
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay">
                <div class="sp-dialog-sheet" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title">
                    <div id="sp-dialog-title" class="sp-dialog-head">${escapeHtml(title)}</div>
                    ${body ? `<div class="sp-dialog-body">${escapeHtml(body)}</div>` : ''}
                    <div class="sp-dialog-single-list">${options}</div>
                    ${customInput}
                    <div class="sp-dialog-input-error" aria-live="polite"></div>
                    <div class="sp-dialog-actions">
                        <button class="sp-dialog-button sp-dialog-button-secondary sp-dialog-cancel" type="button">${escapeHtml(cancelText)}</button>
                        ${actionButtons}
                    </div>
                </div>
            </div>`);
            const session = mountDialog($overlay, resolve);
            if (customValue) $overlay.find('.sp-dialog-custom-input').val(customInitialValue);
            const syncSelection = () => {
                $overlay.find('.sp-dialog-single-option').each(function () {
                    const on = String($(this).attr('data-dialog-value') || '') === selected;
                    $(this).toggleClass('sp-dialog-single-selected', on).attr('aria-pressed', String(on));
                });
                if (customValue) {
                    const on = selected === customValue;
                    $overlay.find('.sp-dialog-custom-input').prop('hidden', !on).prop('disabled', !on);
                    if (on) $overlay.find('.sp-dialog-custom-input').trigger('focus');
                }
            };
            const submit = action => {
                const inputValue = customValue && selected === customValue
                    ? String($overlay.find('.sp-dialog-custom-input').val() ?? '').trim()
                    : '';
                const result = { action: String(action?.value ?? ''), value: selected, customValue: inputValue };
                const raw = typeof validate === 'function' ? validate(result) : '';
                const error = typeof raw === 'string' ? raw : '';
                if (error) {
                    $overlay.find('.sp-dialog-input-error').html(`<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(error)}`);
                    if (customValue && selected === customValue) $overlay.find('.sp-dialog-custom-input').trigger('focus');
                    return;
                }
                session.finish(result);
            };
            $overlay.find('.sp-dialog-single-option').on('click', function () {
                selected = String($(this).attr('data-dialog-value') || '');
                $overlay.find('.sp-dialog-input-error').empty();
                syncSelection();
            });
            $overlay.find('.sp-dialog-custom-input').on('input', () => $overlay.find('.sp-dialog-input-error').empty());
            $overlay.find('[data-dialog-action]').on('click', function () {
                submit(actions[Number($(this).attr('data-dialog-action'))]);
            });
            $overlay.find('.sp-dialog-cancel').on('click', session.close);
            syncSelection();
            setTimeout(() => $overlay.find('.sp-dialog-single-option').first().trigger('focus'), 0);
        });
    }

    // Một lựa chọn bất đồng bộ dùng chung: hộp thoại loại hai tự nạp danh sách lựa chọn, có thể nạp lại ngay trong cùng hộp thoại và hủy lượt yêu cầu trước đó.
    function selectOneAsync({ title = '', body = '', loadChoices, refreshable = false, refreshText = 'Nạp lại', confirmText = 'Đồng ý', cancelText = 'Hủy', cancelValue = null, loadingText = 'Đang nạp…', emptyText = 'Không có nội dung để chọn' } = {}) {
        if (typeof loadChoices !== 'function') return Promise.resolve(null);
        return new Promise(resolve => {
            prepareDialog();
            let requestAbort = null;
            let runId = 0;
            let choices = [];
            let selected = '';
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay">
                <div class="sp-dialog-sheet" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title">
                    <div id="sp-dialog-title" class="sp-dialog-head">${escapeHtml(title)}</div>
                    ${body ? `<div class="sp-dialog-body">${escapeHtml(body)}</div>` : ''}
                    <div class="sp-dialog-async-body"></div>
                    <div class="sp-dialog-input-error" aria-live="polite"></div>
                    <div class="sp-dialog-actions">
                        <button class="sp-dialog-button sp-dialog-button-secondary sp-dialog-cancel" type="button">${escapeHtml(cancelText)}</button>
                        ${refreshable ? `<button class="sp-dialog-button sp-dialog-button-secondary sp-dialog-async-refresh" type="button">${escapeHtml(refreshText)}</button>` : ''}
                        <button class="sp-dialog-button sp-dialog-button-primary sp-dialog-submit" type="button" disabled>${escapeHtml(confirmText)}</button>
                    </div>
                </div>
            </div>`);
            const session = mountDialog($overlay, resolve, { onClose: () => {
                runId++;
                requestAbort?.abort();
                requestAbort = null;
            } });
            const renderChoices = () => {
                const html = choices.length
                    ? `<div class="sp-dialog-single-list sp-dialog-async-list" role="radiogroup">${choices.map(choice => {
                        const value = String(choice?.value ?? '');
                        const on = value === selected;
                        return `<button type="button" role="radio" class="sp-dialog-single-option${on ? ' sp-dialog-single-selected' : ''}" data-dialog-value="${escapeHtml(value)}" aria-checked="${String(on)}"><i class="${on ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle'}" aria-hidden="true"></i><span>${escapeHtml(choice?.label ?? value)}</span></button>`;
                    }).join('')}</div>`
                    : `<div class="sp-dialog-async-empty">${escapeHtml(emptyText)}</div>`;
                $overlay.find('.sp-dialog-async-body').html(html);
                $overlay.find('.sp-dialog-submit').prop('disabled', !selected);
            };
            const load = async () => {
                const myRun = ++runId;
                requestAbort?.abort();
                requestAbort = new AbortController();
                selected = '';
                choices = [];
                $overlay.find('.sp-dialog-input-error').empty();
                $overlay.find('.sp-dialog-submit').prop('disabled', true);
                $overlay.find('.sp-dialog-async-refresh').prop('disabled', true);
                $overlay.find('.sp-dialog-async-body').html(`<div class="sp-dialog-async-loading"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${escapeHtml(loadingText)}</div>`);
                try {
                    const loaded = await loadChoices({ signal: requestAbort.signal });
                    if (session.isDone() || myRun !== runId) return;
                    choices = Array.isArray(loaded) ? loaded : [];
                    renderChoices();
                } catch (error) {
                    if (session.isDone() || myRun !== runId || error?.name === 'AbortError') return;
                    $overlay.find('.sp-dialog-async-body').html(`<div class="sp-dialog-async-empty">${escapeHtml(emptyText)}</div>`);
                    $overlay.find('.sp-dialog-input-error').html(`<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(error?.message || 'Nạp thất bại')}`);
                } finally {
                    if (!session.isDone() && myRun === runId) {
                        requestAbort = null;
                        $overlay.find('.sp-dialog-async-refresh').prop('disabled', false);
                    }
                }
            };
            $overlay.on('click', '.sp-dialog-single-option', function () {
                selected = String($(this).attr('data-dialog-value') || '');
                renderChoices();
            });
            $overlay.find('.sp-dialog-async-refresh').on('click', load);
            $overlay.find('.sp-dialog-submit').on('click', () => { if (selected) session.finish(selected); });
            $overlay.find('.sp-dialog-cancel').on('click', () => session.finish(cancelValue));
            load();
        });
    }

    return Object.freeze({ confirm, choose, prompt, selectMany, selectOne, selectOneAsync, cancelActive });
}
