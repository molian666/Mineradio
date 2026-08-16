const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const refPath = path.join(appRoot, 'public', 'js', 'modules', '07-fx', '10-shortcut-reference.js');
const loaderPath = path.join(appRoot, 'public', 'js', 'index-loader.js');
const hotkeysPath = path.join(appRoot, 'public', 'js', 'modules', '07-fx', '06-hotkeys.js');
const refSource = fs.readFileSync(refPath, 'utf8');
const loaderSource = fs.readFileSync(loaderPath, 'utf8');
const hotkeysSource = fs.readFileSync(hotkeysPath, 'utf8');

const HOTKEY_ACTIONS = [
  { key: 'togglePlay', label: '播放 / 暂停', category: '播放', local: 'Space', global: 'Ctrl+Alt+Space' },
  { key: 'prevTrack', label: '上一首', category: '播放', local: 'ArrowLeft', global: 'Ctrl+Alt+ArrowLeft' },
  { key: 'nextTrack', label: '下一首', category: '播放', local: 'ArrowRight', global: 'Ctrl+Alt+ArrowRight' },
  { key: 'volumeUp', label: '音量增加', category: '音量', local: 'ArrowUp', global: 'Ctrl+Alt+ArrowUp' },
  { key: 'volumeDown', label: '音量降低', category: '音量', local: 'ArrowDown', global: 'Ctrl+Alt+ArrowDown' },
  { key: 'toggleFullscreen', label: '全屏', category: '窗口', local: 'KeyF', global: 'Ctrl+Alt+KeyF' },
  { key: 'toggleDesktopInteraction', label: '切换完整桌面模式', category: '窗口', local: '', global: 'Ctrl+Shift+KeyM' },
  { key: 'toggleDesktopLyrics', label: '桌面歌词', category: '歌词', local: 'Alt+KeyL', global: 'Ctrl+Alt+KeyL' }
];

// 极简 DOM：只在测试需要的范围内实现 createElement / getElementById /
// querySelector / 事件监听 / classList。逐条 data-* 属性可从 innerHTML 抽取。
function createNode(tag, doc) {
  const node = {
    tag,
    id: '',
    _classNameSet: new Set(),
    textContent: '',
    innerHTML: '',
    _innerHTML: '',
    attributes: {},
    listeners: {},
    children: [],
    classList: {
      add(cls) { node._classNameSet.add(cls); },
      remove(cls) { node._classNameSet.delete(cls); },
      contains(cls) { return node._classNameSet.has(cls); },
      toggle(cls, force) {
        if (force === true || (force == null && !node._classNameSet.has(cls))) node._classNameSet.add(cls);
        else node._classNameSet.delete(cls);
      }
    }
  };
  Object.defineProperty(node, 'className', {
    get() { return [...node._classNameSet].join(' '); },
    set(v) {
      node._classNameSet = new Set(String(v || '').split(' ').filter(Boolean));
    }
  });
  Object.defineProperty(node, 'innerHTML', {
    get() { return node._innerHTML; },
    set(v) {
      node._innerHTML = String(v);
      if (doc) {
        // 把模板字符串里出现的 id="..." 注册为可查找的合成节点
        const re = /id="([^"]+)"/g;
        let m;
        while ((m = re.exec(node._innerHTML)) !== null) {
          const id = m[1];
          if (id && !doc._byId[id]) {
            doc._byId[id] = createNode('div', doc);
          }
        }
      }
    }
  });
  node.querySelector = (sel) => doc.querySelector(sel, node);
  node.addEventListener = (type, fn) => {
    (node.listeners[type] = node.listeners[type] || []).push(fn);
  };
  node.appendChild = (child) => {
    node.children.push(child);
    if (child.id && doc) doc._byId[child.id] = child;
    return child;
  };
  node.setAttribute = (k, v) => {
    node.attributes[k] = String(v);
    if (k === 'id' && doc) { node.id = String(v); doc._byId[node.id] = node; }
  };
  node.firstElementChild = null;
  return node;
}

function createDocument() {
  let doc;
  doc = {
    _byId: {},
    body: null,
    addEventListener() {},
    createElement: (tag) => createNode(tag, doc),
    getElementById(id) { return doc._byId[id] || null; },
    querySelector(sel, root) {
      // 支持 #id 与 .class 的简化查找
      const search = root || doc.body;
      if (sel[0] === '#') {
        const id = sel.slice(1);
        return doc._byId[id] || null;
      }
      const cls = sel.slice(1);
      const walk = (n) => {
        if ((n.className || '').split(' ').includes(cls)) return n;
        for (const c of n.children || []) { const r = walk(c); if (r) return r; }
        return null;
      };
      return walk(search);
    }
  };
  doc.body = createNode('body', doc);
  return doc;
}

function createSandbox({ settings }) {
  const document = createDocument();
  const sandbox = {
    console,
    document,
    window: { event: null },
    HOTKEY_ACTIONS,
    formatHotkey(hk) {
      const map = {
        Space: 'Space',
        ArrowLeft: 'Left',
        ArrowRight: 'Right',
        ArrowUp: 'Up',
        ArrowDown: 'Down',
        KeyF: 'F',
        KeyL: 'L',
      };
      if (!hk) return '未设置';
      return String(hk).split('+').map(p => map[p] || p).join(' + ');
    },
    escHtml(s) { return String(s); },
    isTypingTarget(t) { return false; },
    normalizeHotkeyEvent(e) {
      if (e && e.key === '/') return 'Slash';
      if (e && e.key === '?') return 'Slash';
      return '';
    },
    hotkeyCaptureState: null,
    setTimeout,
  };
  sandbox.hotkeySettings = settings || { local: {}, global: {} };
  vm.createContext(sandbox);
  vm.runInContext(refSource, sandbox, { filename: '10-shortcut-reference.js' });
  return { sandbox, document };
}

// 从 body 下某节点的 innerHTML 中抓取全部 data-* 记录。
// 简单解析：匹配 data-action/category/local/global 出现在短线 ref 行里。
function rowsFromHtml(html) {
  const rows = [];
  const re = /data-action="([^"]*)"[^>]*data-category="([^"]*)"[^>]*data-local="([^"]*)"[^>]*data-global="([^"]*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    rows.push({ action: m[1], category: m[2], local: m[3], global: m[4] });
  }
  return rows;
}

function openAndInspect({ settings }) {
  const { sandbox, document } = createSandbox({ settings });
  sandbox.openShortcutReference();
  const modal = document.getElementById('shortcut-ref-modal');
  return { sandbox, document, modal };
}

test('openShortcutReference builds #shortcut-ref-modal and lists every HOTKEY_ACTIONS row', () => {
  const { modal, document } = openAndInspect({ settings: { local: {}, global: {} } });
  assert.ok(modal, 'modal should exist');
  assert.match(modal.className, /hotkey-modal/);
  assert.match(modal.className, /shortcut-ref-mod/);
  const body = document.getElementById('shortcut-ref-body');
  const rows = rowsFromHtml(body.innerHTML);
  assert.equal(rows.length, HOTKEY_ACTIONS.length);
  assert.ok(document.getElementById('shortcut-ref-search'), 'search input should exist');
});

test('rows carry data-local / data-global reflecting hotkeySettings custom bindings', () => {
  const customLocal = HOTKEY_ACTIONS[0].key; // togglePlay
  const { document } = openAndInspect({
    settings: {
      local: { togglePlay: 'KeyP' },
      global: { toggleFullscreen: 'Ctrl+Alt+KeyF' }
    }
  });
  const body = document.getElementById('shortcut-ref-body');
  const rows = rowsFromHtml(body.innerHTML);
  const playRow = rows.find(r => r.action === 'togglePlay');
  const fsRow = rows.find(r => r.action === 'toggleFullscreen');
  // 自定义局内键反映到 data-local
  assert.equal(playRow.local, 'KeyP');
  // 未自定义的全局键回退到默认
  assert.equal(playRow.global, 'Ctrl+Alt+Space');
  // 自定义全局键反映到 data-global
  assert.equal(fsRow.global, 'Ctrl+Alt+KeyF');
});

test('filterShortcutReferenceRows filters by action label, category, and key strings', () => {
  const { sandbox } = createSandbox({ settings: { local: {}, global: {} } });
  // 跨 vm realm 的数组用数组内容比较（JSON 化），避免原型差异
  const idx = (arr) => Array.from(arr || []);
  // 按动作名
  assert.deepEqual(idx(sandbox.filterShortcutReferenceRows('全屏')), [5]);
  // 按类别
  assert.deepEqual(idx(sandbox.filterShortcutReferenceRows('音量')), [3, 4]);
  // 按局内键串 (Arrow)
  assert.deepEqual(idx(sandbox.filterShortcutReferenceRows('Arrow')), [1, 2, 3, 4]);
  // 空查询返回全部
  assert.deepEqual(idx(sandbox.filterShortcutReferenceRows('')), [...HOTKEY_ACTIONS.keys()]);
  // 无匹配返回空
  assert.deepEqual(idx(sandbox.filterShortcutReferenceRows('zzz-no-match')), []);
  // 不区分大小写 + 命中全局键
  assert.deepEqual(idx(sandbox.filterShortcutReferenceRows('ctrl+alt+space')), [0]);
});

test('closeShortcutReference removes the show class', () => {
  const { sandbox, document } = createSandbox({ settings: { local: {}, global: {} } });
  sandbox.openShortcutReference();
  let modal = document.getElementById('shortcut-ref-modal');
  assert.ok(modal.classList.contains('show'));
  sandbox.closeShortcutReference();
  assert.ok(!modal.classList.contains('show'));
});

test('toggleShortcutReference toggles visibility', () => {
  const { sandbox, document } = createSandbox({ settings: { local: {}, global: {} } });
  sandbox.toggleShortcutReference();
  let modal = document.getElementById('shortcut-ref-modal');
  assert.ok(modal.classList.contains('show'));
  sandbox.toggleShortcutReference();
  assert.ok(!modal.classList.contains('show'));
});

test('module registers listener-driven toggle via / or ? keydown', () => {
  const { sandbox } = createSandbox({ settings: { local: {}, global: {} } });
  // normalizeHotkeyEvent('/') -> 'Slash'，触发 toggle
  sandbox.shortcutReferenceKeydown({ key: '/', target: null });
  let modal = sandbox.document.getElementById('shortcut-ref-modal');
  assert.ok(modal.classList.contains('show'));
});

test('ensureShortcutReferenceButton inserts a shortcut reference button in .fx-head', () => {
  const { sandbox, document } = createSandbox({ settings: { local: {}, global: {} } });
  const panel = document.createElement('div');
  panel.id = 'fx-panel';
  const head = document.createElement('div');
  head.className = 'fx-head';
  panel.appendChild(head);
  document.body.appendChild(panel);
  document._byId['fx-panel'] = panel;
  sandbox.ensureShortcutReferenceButton();
  const btn = document.getElementById('shortcut-ref-btn');
  assert.ok(btn, 'shortcut reference button should be created');
  assert.equal(btn.textContent, '快捷键参考');
  // 幂等
  sandbox.ensureShortcutReferenceButton();
  assert.equal(btn, document.getElementById('shortcut-ref-btn'));
});

test('source contract: module wired into loader and hotkeys', () => {
  assert.match(loaderSource, /'js\/modules\/07-fx\/10-shortcut-reference\.js'/);
  assert.match(loaderSource, /'js\/modules\/07-fx\/10-shortcut-reference\.js'[\s\S]*?\n\s*'js\/modules\/07-fx\/07-bindings-shelf-immersive\.js'/);
  // 06-hotkeys bindHotkeySettings 末尾调用 ensureShortcutReferenceButton
  assert.match(hotkeysSource, /function bindHotkeySettings\(\)[\s\S]*ensureShortcutReferenceButton\(\)/);
  // 06-hotkeys executeHotkeyAction 含 toggleShortcutReference 分支
  assert.match(hotkeysSource, /function executeHotkeyAction\([\s\S]*toggleShortcutReference/);
  // 分支带存在性守卫
  assert.match(hotkeysSource, /typeof toggleShortcutReference === 'function'/);
});

console.log('PASS tests/shortcut-reference.test.js');
