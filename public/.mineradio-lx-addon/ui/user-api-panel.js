(function () {
  'use strict';

  var root;
  var state = {
    sources: [],
    activeSourceId: null,
    providers: [],
    loading: false,
    modalOpen: false,
    urlOpen: false,
    feedback: { kind: '', text: '' },
    form: { sourceText: '', label: '', url: '' }
  };
  var api = function () { return window.mineradioUserApi; };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]; });
  }

  function notify(message) {
    if (typeof window.showToast === 'function') window.showToast(message);
  }

  function importErrorMessage(error) {
    var message = String(error && error.message || error || '未知错误');
    if (/Unexpected end of input/i.test(message)) return '歌源导入失败：脚本内容不完整，请检查是否完整复制了歌源文件';
    if (/source syntax error|SyntaxError/i.test(message)) return '歌源导入失败：脚本语法错误，请检查括号、引号和结尾内容';
    if (/size limit|too large|exceeds/i.test(message)) return '歌源导入失败：脚本文件超过 1 MB 大小限制';
    return '歌源导入失败：' + message;
  }

  function feedbackMarkup() {
    if (!state.feedback.text) return '';
    return '<div class="mineradio-lx-feedback mineradio-lx-feedback-' + esc(state.feedback.kind) + '" role="status" aria-live="polite">' + esc(state.feedback.text) + '</div>';
  }

  function sourceLabel(source) {
    return source && source.metadata && (source.metadata.name || source.metadata.label) || source && source.sourceId || 'UserApi 歌源';
  }

  function sourceListMarkup() {
    if (!state.sources.length) return '<div class="cs-empty">尚未导入 UserApi 歌源</div>';
    return state.sources.map(function (source) {
      var active = source.sourceId === state.activeSourceId;
      var providers = (state.providers || []).map(function (item) { return item.source; }).join(' / ') || '未初始化';
      var status = active ? '已启用' : (source.status || '已导入');
      return '<div class="cs-card" data-source-id="' + esc(source.sourceId) + '">' +
        '<span class="cs-card-dot' + (active ? ' active' : '') + '"></span><div class="cs-card-content"><div class="cs-card-title"><strong>' + esc(sourceLabel(source)) + '</strong><span class="cs-status-pill' + (active ? ' active' : '') + '">' + esc(status) + '</span></div><small>' + esc(active ? 'Runtime providers: ' + providers : '等待启用') + '</small></div>' +
        '<div class="cs-card-actions"><button class="cs-btn" type="button" data-action="activate" ' + (active || state.loading ? 'disabled' : '') + '>启用</button><button class="cs-btn" type="button" data-action="remove" ' + (state.loading ? 'disabled' : '') + '>移除</button></div>' +
        '</div>';
    }).join('');
  }

  function feedbackPanelMarkup() {
    var kind = state.feedback.kind || 'empty';
    var text = state.feedback.text || '等待导入';
    return '<div class="cs-feedback-panel cs-feedback-' + esc(kind) + '" role="status" aria-live="polite"><span class="cs-feedback-dot"></span><span class="cs-feedback-text">' + esc(text) + '</span></div>';
  }

  function foldListMarkup() {
    if (!state.sources.length) return '<div class="cs-fold-empty">尚未导入 UserApi 歌源</div>';
    return state.sources.map(function (source) {
      var active = source.sourceId === state.activeSourceId;
      return '<div class="cs-fold-item' + (active ? '' : ' disabled') + '"><span class="cs-fi-dot"></span><span>' + esc(sourceLabel(source)) + '</span><small>' + esc(active ? '已启用' : '未启用') + '</small></div>';
    }).join('');
  }

  function modalMarkup() {
    return '<div id="mineradio-lx-source-modal-mask" class="modal-mask' + (state.modalOpen ? ' show' : '') + '" role="presentation">' +
      '<div class="cs-modal" role="dialog" aria-modal="true" aria-labelledby="mineradio-lx-source-modal-title">' +
        '<div class="cs-modal-head"><div class="cs-modal-heading"><span class="cs-modal-kicker">USERAPI SOURCE MANAGER</span><strong id="mineradio-lx-source-modal-title">UserApi 歌源</strong><small>导入、管理和启用歌源脚本</small></div><button class="cs-modal-close" type="button" data-action="close-modal" title="关闭" aria-label="关闭">×</button></div>' +
        '<div class="cs-modal-body">' +
          '<div class="cs-modal-note"><span class="cs-note-mark">LX</span><div><strong>安全导入</strong><small>支持本地 .js、HTTP(S) URL 和粘贴内容</small></div></div>' +
          '<div class="cs-source-section"><div class="cs-section-head"><div><span class="cs-section-kicker">LIBRARY</span><strong>已导入歌源</strong></div><span class="cs-count">' + state.sources.length + ' 个</span></div><div id="mineradio-lx-source-list" class="cs-list">' + sourceListMarkup() + '</div></div>' +
          '<div class="cs-import-panel"><div class="cs-import-panel-head"><div><span class="cs-section-kicker">IMPORT</span><strong>添加歌源</strong><small>选择一种导入方式</small></div></div>' +
          '<div class="cs-import-methods"><button class="cs-btn cs-method-btn" type="button" data-action="pick-file"' + (state.loading ? ' disabled' : '') + '>本地 .js</button><button class="cs-btn cs-method-btn' + (state.urlOpen ? ' active' : '') + '" type="button" data-action="toggle-url"' + (state.loading ? ' disabled' : '') + '>在线 URL</button></div>' +
          '<div id="mineradio-lx-source-url-row" class="cs-url-row"' + (state.urlOpen ? '' : ' hidden') + '><input id="mineradio-lx-source-url" class="cs-input" name="url" type="url" spellcheck="false" placeholder="https://..."' + (state.loading ? ' disabled' : '') + '><button class="cs-btn primary" type="button" data-action="import-url"' + (state.loading ? ' disabled' : '') + '>导入</button></div>' +
          '<div class="cs-field-row"><label class="cs-field-label" for="mineradio-lx-source-label">显示名称 <span>可选</span></label><input id="mineradio-lx-source-label" class="cs-input" name="label" maxlength="80" placeholder="例如：QQ 歌源"' + (state.loading ? ' disabled' : '') + '></div>' +
          '<div class="cs-field-row"><label class="cs-field-label" for="mineradio-lx-source-text">脚本内容</label><textarea id="mineradio-lx-source-text" class="cs-textarea" name="sourceText" spellcheck="false" placeholder="粘贴 UserApi 脚本内容"' + (state.loading ? ' disabled' : '') + '></textarea></div>' +
          '<div class="cs-import-actions">' + feedbackPanelMarkup() + '<button class="cs-btn primary cs-import-submit" type="button" data-action="import-paste"' + (state.loading ? ' disabled' : '') + '>导入粘贴内容</button></div></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function render() {
    if (!root) return;
    root.innerHTML = '<div class="fx-section-label">UserApi 歌源</div>' +
      '<div class="fx-sub">管理 LX UserApi 歌源脚本，并选择要启用的歌源。</div>' +
      feedbackMarkup() +
      '<div class="fx-fold mineradio-lx-source-fold open">' +
        '<div class="fx-fold-head" data-action="toggle-fold" tabindex="0" role="button" aria-expanded="true"><span class="fx-fold-title"><strong>UserApi 歌源</strong><small>支持 .js、URL 和粘贴内容</small></span><span class="arrow">▶</span></div>' +
        '<div class="fx-fold-body"><div id="mineradio-lx-source-fold-list" class="cs-fold-list">' + foldListMarkup() + '</div><button class="fx-mini-btn" type="button" data-action="open-modal">管理歌源</button></div>' +
      '</div>' +
      modalMarkup();

    var text = root.querySelector('[name="sourceText"]');
    var label = root.querySelector('[name="label"]');
    var url = root.querySelector('[name="url"]');
    if (text) text.value = state.form.sourceText;
    if (label) label.value = state.form.label;
    if (url) url.value = state.form.url;
    bindEvents();
  }

  function setFeedback(kind, text) {
    state.feedback = { kind: kind, text: text };
    notify(text);
  }

  function beginImport() {
    state.loading = true;
    setFeedback('info', '正在导入歌源...');
    render();
  }

  function finishImport(promise) {
    beginImport();
    promise.then(function () {
      state.loading = false;
      state.feedback = { kind: 'success', text: '歌源导入成功' };
      state.form = { sourceText: '', label: '', url: '' };
      notify(state.feedback.text);
      return refresh();
    }).catch(function (error) {
      state.loading = false;
      setFeedback('error', importErrorMessage(error));
      render();
    });
  }

  function importText(text, label) {
    text = String(text || '').trim();
    label = String(label || '').trim();
    if (!text) {
      setFeedback('error', '歌源导入失败：请先选择文件或粘贴脚本内容');
      render();
      return;
    }
    state.form.sourceText = text;
    state.form.label = label;
    finishImport(api().addSource(text, { name: label }));
  }

  function isHttpUrl(value) {
    try { return ['http:', 'https:'].indexOf(new URL(value).protocol) >= 0; } catch (_) { return false; }
  }

  function bindEvents() {
    root.querySelectorAll('[data-action="toggle-fold"]').forEach(function (button) {
      button.addEventListener('click', function () { button.parentNode.classList.toggle('open'); button.setAttribute('aria-expanded', button.parentNode.classList.contains('open') ? 'true' : 'false'); });
      button.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); button.click(); } });
    });
    root.querySelectorAll('[data-action="open-modal"]').forEach(function (button) { button.addEventListener('click', function () { state.modalOpen = true; render(); }); });
    root.querySelectorAll('[data-action="close-modal"]').forEach(function (button) { button.addEventListener('click', function () { state.modalOpen = false; render(); }); });
    var mask = root.querySelector('#mineradio-lx-source-modal-mask');
    if (mask) mask.addEventListener('click', function (event) { if (event.target === mask) { state.modalOpen = false; render(); } });
    root.querySelectorAll('[data-action="toggle-url"]').forEach(function (button) { button.addEventListener('click', function () { state.urlOpen = !state.urlOpen; render(); }); });
    root.querySelectorAll('[data-action="pick-file"]').forEach(function (button) {
      button.addEventListener('click', function () {
        api().pickSourceFile().then(function (picked) {
          if (!picked || picked.canceled) return;
          if (!picked.ok) throw new Error(picked.error || '文件读取失败');
          var label = state.form.label || String(picked.name || '').replace(/\.js$/i, '');
          importText(picked.text, label);
        }).catch(function (error) { setFeedback('error', importErrorMessage(error)); render(); });
      });
    });
    root.querySelectorAll('[data-action="import-url"]').forEach(function (button) {
      button.addEventListener('click', function () {
        var input = root.querySelector('[name="url"]');
        var value = input ? String(input.value || '').trim() : '';
        state.form.url = value;
        if (!value || !isHttpUrl(value)) { setFeedback('error', '歌源导入失败：请输入 HTTP 或 HTTPS 链接'); render(); return; }
        finishImport(api().importSourceUrl(value));
      });
    });
    root.querySelectorAll('[data-action="import-paste"]').forEach(function (button) {
      button.addEventListener('click', function () {
        var text = root.querySelector('[name="sourceText"]');
        var label = root.querySelector('[name="label"]');
        importText(text && text.value, label && label.value);
      });
    });
    root.querySelectorAll('[data-action="activate"]').forEach(function (button) {
      button.addEventListener('click', function () {
        state.loading = true;
        render();
        api().activateSource(button.closest('[data-source-id]').dataset.sourceId).then(refresh).catch(function (error) { state.loading = false; setFeedback('error', '歌源启用失败：' + String(error && error.message || error || '未知错误')); render(); });
      });
    });
    root.querySelectorAll('[data-action="remove"]').forEach(function (button) {
      button.addEventListener('click', function () {
        state.loading = true;
        render();
        api().removeSource(button.closest('[data-source-id]').dataset.sourceId).then(refresh).catch(function (error) { state.loading = false; setFeedback('error', '歌源移除失败：' + String(error && error.message || error || '未知错误')); render(); });
      });
    });
  }

  function refresh() {
    return Promise.all([api().getState(), api().getAvailableLxProviders()]).then(function (values) {
      state.sources = values[0].sources || [];
      state.activeSourceId = values[0].activeSourceId || null;
      state.providers = values[1] || [];
      state.loading = false;
      render();
    });
  }

  function mount() {
    root = document.getElementById('mineradio-lx-user-api-panel');
    if (root && api()) refresh().catch(function (error) { state.loading = false; setFeedback('error', '歌源状态读取失败：' + String(error && error.message || error || '未知错误')); render(); });
  }

  window.mineradioLxUserApiPanel = { refresh: refresh, mount: mount };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
}());
