const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const hotkeysPath = path.join(appRoot, 'public', 'js', 'modules', '07-fx', '06-hotkeys.js');
const lyricsPath = path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js');
const hotkeysSource = fs.readFileSync(hotkeysPath, 'utf8');
const lyricsSource = fs.readFileSync(lyricsPath, 'utf8');

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

function createButton(selector, baseTitle) {
  const btn = {
    selector,
    title: baseTitle,
    ariaLabel: '',
  };
  return btn;
}

function createSandbox({ settings }) {
  const buttons = {
    '#prev-btn': createButton('#prev-btn', '上一首'),
    '#play-btn': createButton('#play-btn', '播放/暂停'),
    '#next-btn': createButton('#next-btn', '下一首'),
    '#volume-btn': createButton('#volume-btn', '音量 / 静音'),
    '.fullscreen-toggle-btn': createButton('.fullscreen-toggle-btn', '全屏'),
  };
  const sandbox = {
    console,
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelector(sel) { return buttons[sel] || null; },
    },
    hotkeySettings: settings || { local: {}, global: {} },
    HOTKEY_ACTIONS,
    window: {},
    setInterval: () => 0,
    clearInterval: () => {},
    Date,
    Number,
    String,
    Math,
    Array,
    Object,
    setTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(hotkeysSource, sandbox, { filename: '06-hotkeys.js' });
  return { sandbox, buttons };
}

test('hotkeyButtonHint renders the configured local shortcut', () => {
  const { sandbox } = createSandbox({
    settings: {
      local: { togglePlay: 'Space', nextTrack: 'ArrowRight' },
      global: {}
    }
  });
  assert.equal(sandbox.hotkeyButtonHint('togglePlay'), ' · 快捷键: Space');
  assert.equal(sandbox.hotkeyButtonHint('nextTrack'), ' · 快捷键: Right');
});

test('hotkeyButtonHint falls back to global hotkey when local is unset', () => {
  const { sandbox } = createSandbox({
    settings: {
      local: { toggleDesktopLyrics: '' },
      global: { toggleDesktopLyrics: 'Alt+KeyL' }
    }
  });
  assert.equal(sandbox.hotkeyButtonHint('toggleDesktopLyrics'), ' · 快捷键: Alt + L');
});

test('hotkeyButtonHint returns empty string when no binding exists', () => {
  const { sandbox } = createSandbox({ settings: { local: {}, global: {} } });
  assert.equal(sandbox.hotkeyButtonHint('togglePlay'), '');
});

test('applyHotkeyButtonHints appends shortcuts to mapped control buttons once', () => {
  const { sandbox, buttons } = createSandbox({
    settings: {
      local: { prevTrack: 'ArrowLeft', togglePlay: 'Space', nextTrack: 'ArrowRight', volumeUp: 'ArrowUp', toggleFullscreen: 'KeyF' },
      global: {}
    }
  });
  sandbox.applyHotkeyButtonHints();
  sandbox.applyHotkeyButtonHints(); // 幂等：不叠加
  assert.equal(buttons['#prev-btn'].title, '上一首 · 快捷键: Left');
  assert.equal(buttons['#play-btn'].title, '播放/暂停 · 快捷键: Space');
  assert.equal(buttons['#next-btn'].title, '下一首 · 快捷键: Right');
  assert.equal(buttons['#volume-btn'].title, '音量 / 静音 · 快捷键: Up');
  assert.equal(buttons['.fullscreen-toggle-btn'].title, '全屏 · 快捷键: F');
});

test('desktop lyrics button title appends the hotkey hint from the lyrics module', () => {
  assert.match(hotkeysSource, /function hotkeyButtonHint\s*\(actionKey\)/);
  assert.match(hotkeysSource, /HOTKEY_TITLE_BUTTON_MAP\s*=/);
  assert.match(hotkeysSource, /function applyHotkeyButtonHints\s*\(\)/);
  // 歌词模块的桌面歌词按钮标题会追加热键提示
  assert.match(lyricsSource, /hotkeyButtonHint\(['"]toggleDesktopLyrics['"]\)/);
});

test('bindHotkeySettings applies button hints at startup', () => {
  assert.match(hotkeysSource, /function bindHotkeySettings\(\)[\s\S]*applyHotkeyButtonHints\(\)/);
  assert.match(hotkeysSource, /function setHotkeyBinding\([\s\S]*applyHotkeyButtonHints\(\)/);
});

console.log('PASS tests/hotkey-button-tooltip.test.js');
