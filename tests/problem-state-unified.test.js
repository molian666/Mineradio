const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const modulePath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '20-problem-state-unified.js');
const loaderPath = path.join(appRoot, 'public', 'js', 'index-loader.js');
const moduleSource = fs.readFileSync(modulePath, 'utf8');
const loaderSource = fs.readFileSync(loaderPath, 'utf8');

function createElementMock() {
  const el = {
    children: [],
    className: '',
    textContent: '',
    innerHTML: '',
    type: '',
    onclick: null,
    classList: {
      add() {},
      remove() {},
      contains() { return false; },
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute() {},
  };
  return el;
}

// 返回扁平化的后代按钮列表，方便断言卡片上一共渲染了哪些操作按钮。
function collectButtons(root, out) {
  out = out || [];
  (root.children || []).forEach(function (child) {
    var isAction = child && String(child.tagName || '').toLowerCase() === 'button'
      && String(child.className || '').indexOf('source-fallback-action') >= 0;
    if (isAction) out.push(child);
    collectButtons(child, out);
  });
  return out;
}

function createSandbox() {
  const stack = {
    children: [],
    lastElementChild: null,
    insertBefore(child) {
      this.children.unshift(child);
      this.lastElementChild = child;
    },
  };
  let removedCards = 0;
  let removedFallbackCalls = 0;
  const searchBoxFocused = [];
  const document = {
    body: createElementMock(),
    getElementById(id) {
      if (id === 'source-fallback-stack') return stack;
      if (id === 'search-box') {
        return {
          focus() { searchBoxFocused.push(id); },
        };
      }
      if (id === 'search-area') return createElementMock();
      return null;
    },
    createElement(tag) {
      const el = createElementMock();
      el.tagName = String(tag).toUpperCase();
      return el;
    },
  };
  const requestLoginSources = [];
  const sandbox = {
    console,
    window: {},
    document,
    setTimeout,
    clearTimeout,
    requestAnimationFrame(fn) { fn(); },
    playQueue: [],
    currentIdx: -1,
    ensureSourceFallbackStack() { return stack; },
    removeSourceFallbackCard(card) {
      removedFallbackCalls++;
      removedCards++;
    },
    showLoginModal(opts) {
      requestLoginSources.push(opts && opts.source || '');
    },
    setPeek() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(moduleSource, sandbox, { filename: '20-problem-state-unified.js' });
  return { sandbox, stack, documentSearchBoxFocused: searchBoxFocused, requestLoginSources, removedFallbackCalls: () => removedFallbackCalls };
}

test('showProblemCard renders retry, login and search action buttons on one card', () => {
  const ctx = createSandbox();
  let retried = 0;
  ctx.sandbox.showProblemCard('vip_required', {
    title: '会员曲目',
    body: '需要会员权限',
    retry: true,
    onRetry: function () { retried++; },
    login: true,
    search: true,
    source: 'qq',
  });
  const card = ctx.stack.children[0];
  assert.ok(card, 'card must be inserted into the fallback stack');
  assert.ok(card.classList, 'card must expose classList for show transition');
  const buttons = collectButtons(card);
  const labels = buttons.map(function (b) { return b.textContent; });
  assert.deepEqual(labels, ['重试', '去登录', '去搜索'], 'buttons render in order');
  // 点击重试：调用 onRetry
  buttons[0].onclick();
  assert.equal(retried, 1, 'onRetry must fire');
  // 点击去登录：写入 window 来源并打开登录弹窗
  buttons[1].onclick();
  assert.equal(ctx.sandbox.window.__mineradioRequestLoginSource, 'qq', 'login source recorded on window');
  assert.deepEqual(ctx.requestLoginSources, ['qq'], 'showLoginModal called with source');
  // 点击去搜索：聚焦 search-box
  buttons[2].onclick();
  assert.deepEqual(ctx.documentSearchBoxFocused, ['search-box'], 'search-box focused');
});

test('retry falls back to playQueueAt when no onRetry provided', () => {
  const ctx = createSandbox();
  let playedAt = -1;
  ctx.sandbox.playQueueAt = function (idx) { playedAt = idx; };
  ctx.sandbox.currentIdx = 3;
  ctx.sandbox.showProblemCard('network', { title: '网络问题', retry: true });
  const buttons = collectButtons(ctx.stack.children[0]);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, '重试');
  buttons[0].onclick();
  assert.equal(playedAt, 3, 'default retry replays current index through playQueueAt');
});

test('every action click closes the problem card', () => {
  const ctx = createSandbox();
  ctx.sandbox.showProblemCard('generic', { title: '问题', retry: true, login: true, search: true });
  const before = ctx.removedFallbackCalls();
  collectButtons(ctx.stack.children[0]).forEach(function (b) { b.onclick(); });
  assert.equal(ctx.removedFallbackCalls(), before + 3, 'each button press removes one card');
});

test('showPlaybackProblemForError returns the correct kind and maps buttons', () => {
  const ctx = createSandbox();
  ctx.sandbox.playbackFailureToastText = function (err) { return '分类文案'; };
  ctx.sandbox.playbackFailureNoticeFromError = function () { return null; };

  const loginKind = ctx.sandbox.showPlaybackProblemForError(new Error('login_required 401'));
  assert.equal(loginKind, 'login_required');
  assert.ok(collectButtons(ctx.stack.children[0]).some(function (b) { return b.textContent === '去登录'; }));

  const vipKind = ctx.sandbox.showPlaybackProblemForError(new Error('vip_required'));
  assert.equal(vipKind, 'vip_required');
  assert.equal(collectButtons(ctx.stack.children[0]).length, 0, 'vip 只给文案不给按钮');

  const copyKind = ctx.sandbox.showPlaybackProblemForError(new Error('copyright_unavailable'));
  assert.equal(copyKind, 'copyright_unavailable');
  assert.ok(collectButtons(ctx.stack.children[0]).some(function (b) { return b.textContent === '去搜索'; }));

  const netKind = ctx.sandbox.showPlaybackProblemForError(new Error('network timeout'));
  assert.equal(netKind, 'network');
  assert.ok(collectButtons(ctx.stack.children[0]).some(function (b) { return b.textContent === '重试'; }));
});

test('showEmptyQueueProblem reports an empty queue and renders a search action', () => {
  const ctx = createSandbox();
  ctx.sandbox.playQueue = [];
  ctx.sandbox.currentIdx = -1;
  assert.equal(ctx.sandbox.showEmptyQueueProblem(), true, 'empty queue reports true');
  const buttons = collectButtons(ctx.stack.children[0]);
  assert.ok(buttons.some(function (b) { return b.textContent === '去搜索'; }), 'empty queue card includes search');
});

test('showEmptyQueueProblem stays silent when playQueue has a playable current item', () => {
  const ctx = createSandbox();
  ctx.sandbox.playQueue = [{ id: 1 }, { id: 2 }];
  ctx.sandbox.currentIdx = 0;
  assert.equal(ctx.sandbox.showEmptyQueueProblem(), false, 'non-empty queue reports false without a card');
  assert.equal(ctx.stack.children.length, 0, 'no card inserted');
});

test('index-loader registers the unified problem module and it lives before 06-lyrics', () => {
  assert.match(loaderSource, /js\/modules\/05-playback\/20-problem-state-unified\.js/);
  const loaderLyricsAt = loaderSource.indexOf('js/modules/06-lyrics/00-lyrics-fetch-parse.js');
  const loaderModuleAt = loaderSource.indexOf('js/modules/05-playback/20-problem-state-unified.js');
  assert.ok(loaderModuleAt >= 0 && loaderLyricsAt > loaderModuleAt, 'problem module loads before the 06-lyrics directory');
});

test('module exports showProblemCard and showPlaybackProblemForError', () => {
  assert.match(moduleSource, /function showProblemCard\s*\(/);
  assert.match(moduleSource, /function showPlaybackProblemForError\s*\(/);
  assert.match(moduleSource, /function showEmptyQueueProblem\s*\(/);
});

test('classification strings for login/copyright/network are present', () => {
  assert.match(moduleSource, /login_required/);
  assert.match(moduleSource, /copyright_unavailable/);
  assert.match(moduleSource, /failed to fetch|timeout|econnreset|etimedout/);
});

console.log('PASS tests/problem-state-unified.test.js');
