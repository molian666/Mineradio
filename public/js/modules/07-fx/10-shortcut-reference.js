// 快捷键说明浮层（只读 / 可搜索）：
//  与「热键设置」弹窗（改绑）互补——本面板只做"查看 / 搜索"全量快捷键。
//  复用 .hotkey-modal / .hotkey-dialog 的视觉类名，另加专属 shortcut-ref-* 类。
//  通过 / 或 ?（外加热键动作 toggleShortcutReference）呼出/收起。
var SHORTCUT_REF_OPENED = false;

// 计算一行快捷键说明的局内 / 全局展示键：
// 优先用户自定义（hotkeySettings.local / global），否则回退到默认（action.local / global）。
// formatHotkey 负责把 'ArrowLeft' 还原为可读 'Left'。
function shortcutReferenceRowBindings(action) {
  var localKey = hotkeySettings && hotkeySettings.local && hotkeySettings.local[action.key];
  var globalKey = hotkeySettings && hotkeySettings.global && hotkeySettings.global[action.key];
  var localRaw = localKey == null ? (action.local || '') : String(localKey);
  var globalRaw = globalKey == null ? (action.global || '') : String(globalKey);
  return {
    local: formatHotkey ? formatHotkey(localRaw) : localRaw,
    global: formatHotkey ? formatHotkey(globalRaw) : globalRaw,
    localRaw: localRaw,
    globalRaw: globalRaw
  };
}

// 过滤快捷键说明记录：按动作名 / 类别 / 键串（局内+全局）做不区分大小写子串匹配。
// query 为空时返回全部下标。供单测直接调用。
function filterShortcutReferenceRows(query) {
  var q = String(query || '').trim().toLowerCase();
  var out = [];
  if (!HOTKEY_ACTIONS) return out;
  HOTKEY_ACTIONS.forEach(function (action, index) {
    if (!q) {
      out.push(index);
      return;
    }
    var bindings = shortcutReferenceRowBindings(action);
    var haystack = String(action.label || '').toLowerCase() + '\n' +
      String(action.category || '').toLowerCase() + '\n' +
      String(bindings.local || '').toLowerCase() + '\n' +
      String(bindings.global || '').toLowerCase() + '\n' +
      String(action.local || '').toLowerCase() + '\n' +
      String(action.global || '').toLowerCase();
    if (haystack.indexOf(q) >= 0) out.push(index);
  });
  return out;
}

// 渲染一行快捷键说明（含 data 属性供搜索过滤 / 样式定位）。
function shortcutReferenceRowMarkup(action) {
  var bindings = shortcutReferenceRowBindings(action);
  var cleanLocal = String(bindings.localRaw || '').replace(/"/g, '&quot;');
  var cleanGlobal = String(bindings.globalRaw || '').replace(/"/g, '&quot;');
  var cleanKey = String(action.key || '').replace(/"/g, '&quot;');
  var cleanCategory = String(action.category || '').replace(/"/g, '&quot;');
  return '<div class="shortcut-ref-row hotkey-row" data-action="' + cleanKey +
    '" data-category="' + cleanCategory +
    '" data-local="' + cleanLocal +
    '" data-global="' + cleanGlobal + '">' +
    '<div class="hotkey-name">' + escHtml(action.label || action.key) + '</div>' +
    '<div class="shortcut-ref-key">' + escHtml(bindings.local) + '</div>' +
    '<div class="shortcut-ref-key">' + escHtml(bindings.global) + '</div>' +
    '</div>';
}

// 组建浮层 DOM（不存在才创建），返回面板节点。
function ensureShortcutReferenceModal() {
  var existing = document.getElementById('shortcut-ref-modal');
  if (existing) return existing;
  var modal = document.createElement('div');
  modal.id = 'shortcut-ref-modal';
  modal.className = 'hotkey-modal shortcut-ref-modal';
  modal.innerHTML =
    '<div class="hotkey-dialog shortcut-ref-dialog" role="dialog" aria-modal="true" aria-label="快捷键参考">' +
    '<div class="hotkey-head shortcut-ref-head">' +
    '<div><div class="hotkey-title">快捷键参考</div><div class="hotkey-sub">全量快捷键速查（只读）· 按 / 或 ? 随时呼出，输入关键词可过滤。</div></div>' +
    '<button class="hotkey-close" type="button" data-shortcut-ref-close aria-label="关闭">×</button>' +
    '</div>' +
    '<div class="hotkey-toolbar">' +
    '<input id="shortcut-ref-search" class="shortcut-ref-search" type="text" placeholder="搜索动作 / 类别 / 按键..." autocomplete="off" />' +
    '<div class="hotkey-note shortcut-ref-note"><span class="shortcut-ref-col-head">局内键</span><span class="shortcut-ref-col-head">全局键</span></div>' +
    '</div>' +
    '<div id="shortcut-ref-body" class="shortcut-ref-body"></div>' +
    '</div>';
  var search = modal.querySelector('#shortcut-ref-search');
  if (search) search.addEventListener('input', function (e) {
    renderShortcutReference(e.target.value);
  });
  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeShortcutReference();
    if (e.target.closest && e.target.closest('[data-shortcut-ref-close]')) closeShortcutReference();
  });
  document.body.appendChild(modal);
  return modal;
}

// 依据查询串渲染面板内容（分组 + 过滤）。
function renderShortcutReference(query) {
  var modal = ensureShortcutReferenceModal();
  var body = document.getElementById('shortcut-ref-body');
  if (!body) return;
  var indices = filterShortcutReferenceRows(query);
  var byCategory = {};
  indices.forEach(function (index) {
    var action = HOTKEY_ACTIONS[index];
    var cat = action.category || '其他';
    (byCategory[cat] = byCategory[cat] || []).push(action);
  });
  var html = '';
  Object.keys(byCategory).forEach(function (category) {
    html += '<div class="hotkey-group shortcut-ref-group"><div class="hotkey-group-title">' + escHtml(category) + '</div>';
    (byCategory[category] || []).forEach(function (action) {
      html += shortcutReferenceRowMarkup(action);
    });
    html += '</div>';
  });
  if (!indices.length) {
    html += '<div class="shortcut-ref-empty">没有匹配的快捷键，换个关键词试试。</div>';
  }
  body.innerHTML = html;
}

// 打开 / 刷新快捷键参考面板。
function openShortcutReference() {
  var modal = ensureShortcutReferenceModal();
  modal.classList.add('show');
  SHORTCUT_REF_OPENED = true;
  renderShortcutReference('');
  var search = document.getElementById('shortcut-ref-search');
  if (search) setTimeout(function () { try { search.focus(); } catch (e) { } }, 10);
}

// 关闭快捷键参考面板。
function closeShortcutReference() {
  SHORTCUT_REF_OPENED = false;
  var modal = document.getElementById('shortcut-ref-modal');
  if (modal) modal.classList.remove('show');
}

// 切换快捷键参考面板开/关。
function toggleShortcutReference() {
  var modal = document.getElementById('shortcut-ref-modal');
  var isOpen = modal && modal.classList && modal.classList.contains('show');
  if (isOpen) closeShortcutReference();
  else openShortcutReference();
}

// 在 fx 面板头部插入「快捷键参考」按钮（与现有「热键」按钮并排）。
// 参考 06-hotkeys.js 的 ensureHotkeySettingsButton 做法（fx-head-actions），幂等。
function ensureShortcutReferenceButton() {
  var panel = document.getElementById('fx-panel');
  var head = panel && panel.querySelector('.fx-head');
  if (!head || document.getElementById('shortcut-ref-btn')) return;
  var actions = head.querySelector('.fx-head-actions');
  if (!actions) {
    if (head.firstElementChild) head.firstElementChild.classList.add('fx-head-main');
    actions = document.createElement('div');
    actions.className = 'fx-head-actions';
    head.appendChild(actions);
  }
  var btn = document.createElement('button');
  btn.id = 'shortcut-ref-btn';
  btn.type = 'button';
  btn.className = 'fx-mini-btn ghost';
  btn.textContent = '快捷键参考';
  btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggleShortcutReference(); });
  actions.appendChild(btn);
}

// 全局键盘：按 / 或 ? 呼出/收起（不在输入框、且未处于改绑录入状态时）。
// 复用 06-hotkeys.js 的 normalizeHotkeyEvent / isTypingTarget（isTypingTarget 来自
// 05-playback/01-cover-custom-map.js），为免循环依赖用 typeof 守卫。
function shortcutReferenceKeydown(e) {
  e = e || (typeof window !== 'undefined' && window.event);
  if (!e) return;
  if (typeof isTypingTarget === 'function' && isTypingTarget(e.target)) return;
  if (typeof hotkeyCaptureState !== 'undefined' && hotkeyCaptureState) return;
  // 优先 normalizeHotkeyEvent：把任意来源事件还原成组合键串（此处预期得到 'Slash'）。
  var combo = '';
  if (typeof normalizeHotkeyEvent === 'function') {
    try { combo = normalizeHotkeyEvent(e); } catch (err) { combo = String(e.key || ''); }
  } else {
    combo = String(e.key || '');
  }
  var key = String(e.key || '');
  if (key !== '/' && key !== '?' && combo !== 'Slash') return;
  if (e.preventDefault) e.preventDefault();
  if (e.stopPropagation) e.stopPropagation();
  toggleShortcutReference();
}
var SHORTCUT_REF_LISTENER_BOUND = false;
function bindShortcutReference() {
  if (SHORTCUT_REF_LISTENER_BOUND || !document || typeof document.addEventListener !== 'function') return;
  SHORTCUT_REF_LISTENER_BOUND = true;
  document.addEventListener('keydown', shortcutReferenceKeydown, true);
}
bindShortcutReference();
