/* mineradio-lx-addon: unified playback problem exit (ROADMAP 3.1-1) */
var problemStateKinds = {
  NETWORK: 'network',
  VIP: 'vip_required',
  LOGIN: 'login_required',
  COPYRIGHT: 'copyright_unavailable',
  EMPTY_QUEUE: 'empty_queue',
  GENERIC: 'generic'
};
var PROBLEM_CARD_AUTO_CLOSE_MS = 8000;

function openProblemCardLogin(source) {
  // 「去登录」按钮统一出口：先把平台来源记录到 window，再打开登录弹窗。
  var requestSource = String(source || '').trim();
  if (typeof window !== 'undefined' && window) window.__mineradioRequestLoginSource = requestSource;
  if (typeof showLoginModal === 'function') showLoginModal({ source: requestSource });
}
function problemCardFocusSearch() {
  // 「去搜索」按钮统一出口：聚焦搜索框，并尽力把搜索面板打开。
  var searchBox = document.getElementById('search-box');
  if (searchBox && typeof searchBox.focus === 'function') searchBox.focus();
  if (typeof setPeek === 'function') {
    var searchArea = document.getElementById('search-area');
    if (searchArea) setPeek(searchArea, true, 'search');
  }
}
function problemCardDefaultRetry() {
  // 「重试」按钮缺省实现：重新播放当前歌曲。playQueueAt 可能不存在（如测试沙箱），
  // 存在才调用，并带上 manual 以便走完整的播放入口。
  if (typeof playQueueAt === 'function') {
    var index = (typeof currentIdx === 'number') ? currentIdx : (currentIdx >= 0 ? currentIdx : 0);
    playQueueAt(index, { manual: true });
  }
}
function buildProblemCardActionButton(label, onClick) {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'source-fallback-action';
  btn.textContent = label;
  btn.onclick = onClick;
  return btn;
}
function showProblemCard(kind, opts) {
  opts = opts || {};
  var resolvedKind = String(kind || problemStateKinds.GENERIC);
  if (typeof ensureSourceFallbackStack !== 'function') return '';
  var stack = ensureSourceFallbackStack();
  if (!stack) return resolvedKind;
  var card = document.createElement('div');
  card.className = 'source-fallback-card source-fallback-problem-card';
  var head = document.createElement('div');
  head.className = 'source-fallback-head';
  var titleEl = document.createElement('div');
  titleEl.className = 'source-fallback-title';
  titleEl.textContent = opts.title || '遇到了问题';
  var close = document.createElement('button');
  close.className = 'source-fallback-close';
  close.type = 'button';
  close.textContent = '×';
  close.onclick = function () {
    if (typeof removeSourceFallbackCard === 'function') removeSourceFallbackCard(card);
  };
  head.appendChild(titleEl);
  head.appendChild(close);
  card.appendChild(head);
  if (opts.body) {
    var bodyEl = document.createElement('div');
    bodyEl.className = 'source-fallback-body';
    bodyEl.textContent = opts.body;
    card.appendChild(bodyEl);
  }
  var actions = document.createElement('div');
  actions.className = 'source-fallback-actions';
  // 「重试」：存在时触发 opts.onRetry（缺省重新播放当前歌曲）。
  if (opts.retry) {
    actions.appendChild(buildProblemCardActionButton('重试', function () {
      try {
        if (typeof opts.onRetry === 'function') opts.onRetry();
        else problemCardDefaultRetry();
      } catch (e) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[ProblemCard] retry failed:', e);
      }
      if (typeof removeSourceFallbackCard === 'function') removeSourceFallbackCard(card);
    }));
  }
  // 「去登录」：登录类问题。绑定平台来源后打开登录弹窗。
  if (opts.login) {
    var loginSource = opts.source || '';
    actions.appendChild(buildProblemCardActionButton('去登录', function () {
      openProblemCardLogin(loginSource);
      if (typeof removeSourceFallbackCard === 'function') removeSourceFallbackCard(card);
    }));
  }
  // 「去搜索」：版权受限/队列为空/未知错误时，让用户去搜索其它版本。
  if (opts.search || opts.empty) {
    actions.appendChild(buildProblemCardActionButton('去搜索', function () {
      problemCardFocusSearch();
      if (typeof removeSourceFallbackCard === 'function') removeSourceFallbackCard(card);
    }));
  }
  if (actions.children && actions.children.length) card.appendChild(actions);
  stack.insertBefore(card, stack.firstChild || null);
  while (stack.children && stack.children.length > 4) {
    if (typeof removeSourceFallbackCard === 'function' && stack.lastElementChild) {
      removeSourceFallbackCard(stack.lastElementChild);
    }
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { card.classList.add('show'); });
  else card.classList.add('show');
  setTimeout(function () {
    if (typeof removeSourceFallbackCard === 'function') removeSourceFallbackCard(card);
  }, PROBLEM_CARD_AUTO_CLOSE_MS);
  return resolvedKind;
}
function showPlaybackProblemForError(err, opts) {
  opts = opts || {};
  // 复用既有文案分类与纯文本提示。
  var text = '';
  if (typeof playbackFailureToastText === 'function') text = playbackFailureToastText(err);
  var notice = null;
  if (typeof playbackFailureNoticeFromError === 'function') notice = playbackFailureNoticeFromError(err);
  var kind = problemStateKinds.GENERIC;
  var msg = String(err && err.message ? err.message : (err || '')).trim();
  var lower = msg.toLowerCase();
  if (/vip_required|paid_required|trial_only|need_vip|only_vip|member|vip|会员|付费|购买/.test(lower + msg)) {
    kind = problemStateKinds.VIP;
  } else if (/401|403|login_required|auth|cookie|credential|unauthorized|forbidden/.test(lower)) {
    kind = problemStateKinds.LOGIN;
  } else if (/copyright|not playable|unavailable/.test(lower)) {
    kind = problemStateKinds.COPYRIGHT;
  } else if (/network|failed to fetch|timeout|econnreset|etimedout|err_connection|http 5|502|503|504/.test(lower)) {
    kind = problemStateKinds.NETWORK;
  }
  var title = opts.title || (notice && notice.title) || '';
  var body = opts.body || text || (notice && notice.body) || '';
  if (!title && body) title = '播放出了问题';
  var cardOpts = {
    title: title,
    body: body,
    source: opts.source || opts.provider || ''
  };
  if (kind === problemStateKinds.LOGIN) {
    cardOpts.login = true;
  } else if (kind === problemStateKinds.VIP) {
    // VIP 曲目仅给文案，不给可操作按钮。
  } else if (kind === problemStateKinds.COPYRIGHT) {
    cardOpts.search = true;
  } else if (kind === problemStateKinds.NETWORK) {
    cardOpts.retry = true;
    cardOpts.onRetry = opts.onRetry;
  } else {
    cardOpts.search = true;
  }
  if (typeof showProblemCard === 'function') showProblemCard(kind, cardOpts);
  return kind;
}
function showEmptyQueueProblem(opts) {
  opts = opts || {};
  var queueEmpty = !Array.isArray(playQueue) || !playQueue.length;
  if (!queueEmpty) {
    var currentPlayable = typeof currentIdx === 'number' && currentIdx >= 0 && currentIdx < playQueue.length;
    if (currentPlayable) return false;
  }
  if (typeof showProblemCard === 'function') {
    showProblemCard(problemStateKinds.EMPTY_QUEUE, {
      title: opts.title || '播放队列是空的',
      body: opts.body || '当前没有任何可播放的歌曲，去搜索或导入一首再来播放吧。',
      search: true,
      empty: true
    });
  }
  return true;
}
